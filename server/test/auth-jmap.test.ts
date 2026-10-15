import { env, exports } from "cloudflare:workers";
import { Hono } from "hono";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { jmapAuth, resetJmapAuthCaches } from "../src/auth/jmap-auth";
import type { AppEnv } from "../src/auth/types";
import { generateKeyPair, exportJWK, SignJWT } from "jose";
import {
  acceptInvite,
  bootstrapAdmin,
  request,
  resetDb as resetTables,
  type Session,
  type Json,
} from "./helpers";

vi.mock("../src/send", () => ({ sendSystemMail: vi.fn(async () => {}) }));

// What the JMAP module does: put jmapAuth in front of its routes and read c.var.principal.
const jmap = new Hono<AppEnv>();
jmap.use("*", jmapAuth);
jmap.get("/session", (c) => c.json(c.var.principal));
const callJmap = (authorization?: string, bindings: Env = env) =>
  jmap.fetch(
    new Request("http://localhost:8787/session", {
      headers: authorization ? { authorization } : {},
    }),
    bindings,
  );

/** Tables are wiped, so the per-isolate key/client caches of jmapAuth must go too. */
async function resetDb(): Promise<void> {
  await resetTables();
  resetJmapAuthCaches();
}

/** A copy of the bindings whose D1 records every SQL string prepared through it. */
function recordingEnv(): { bindings: Env; sql: string[] } {
  const sql: string[] = [];
  const DB = new Proxy(env.DB, {
    get(target, prop) {
      const value = Reflect.get(target, prop, target);
      if (prop === "prepare") {
        return (query: string) => {
          sql.push(query);
          return target.prepare(query);
        };
      }
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  return { bindings: { ...env, DB } as Env, sql };
}

/** Tables a recorded SQL string reads or writes (`from "x"`, `into "x"`, `update "x"`). */
const tablesOf = (sql: string[]) =>
  [
    ...new Set(
      sql
        .flatMap((q) => [...q.matchAll(/(?:from|into|update|join)\s+"?(\w+)"?/gi)])
        .map((m) => m[1]!),
    ),
  ].toSorted();

const decodePart = (jwt: string, index: 0 | 1): Json =>
  JSON.parse(atob(jwt.split(".")[index]!.replaceAll("-", "+").replaceAll("_", "/")));

const bearer = (t: string) => `Bearer ${t}`;
const sidOf = (t: string) => decodePart(t, 1).sid as string;

const BASE = "http://localhost:8787";
const JMAP_RESOURCE = `${BASE}/jmap`;

const basic = (user: string, pass: string) => `Basic ${btoa(`${user}:${pass}`)}`;

async function createAppPassword(session: Session): Promise<string> {
  const res = await request<{ key: string }>("/api/auth/api-key/create", {
    method: "POST",
    cookie: session.cookie,
    json: { name: "Thunderbird" },
  });
  expect(res.status).toBe(200);
  return res.body.key;
}

function b64url(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");
}

const REDIRECT = "http://localhost:4173/oauth/callback";

/** Starts an authorization-code + PKCE flow against the Bulwark client; returns the redirect. */
async function authorize(session: Session, resource?: string) {
  const verifier = b64url(crypto.getRandomValues(new Uint8Array(32)));
  const challenge = b64url(
    new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))),
  );
  const q = new URLSearchParams({
    response_type: "code",
    client_id: "bulwark-lite",
    redirect_uri: REDIRECT,
    scope: "openid profile email offline_access",
    state: "xyz",
    code_challenge: challenge,
    code_challenge_method: "S256",
    ...(resource ? { resource } : {}),
  });
  const authz = await request(`/api/auth/oauth2/authorize?${q}`, { cookie: session.cookie });
  expect(authz.status).toBe(302);
  return { location: new URL(authz.headers.get("location")!), verifier };
}

/** Authorization-code + PKCE flow against the Bulwark client; returns the token response. */
async function oauthTokens(session: Session, resource?: string) {
  const { location, verifier } = await authorize(session, resource);
  expect(location.origin + location.pathname).toBe(REDIRECT);
  expect(location.searchParams.get("state")).toBe("xyz");
  const code = location.searchParams.get("code")!;
  expect(code).toBeTruthy();

  return fetchToken(code, verifier, REDIRECT, resource);
}

async function fetchToken(code: string, verifier: string, redirect: string, resource?: string) {
  const res = await exports.default.fetch(
    new Request("http://localhost:8787/api/auth/oauth2/token", {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        origin: "http://localhost:4173",
      },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code,
        redirect_uri: redirect,
        client_id: "bulwark-lite",
        code_verifier: verifier,
        ...(resource ? { resource } : {}),
      }),
    }),
  );
  return { status: res.status, body: (await res.json()) as Json, headers: res.headers };
}

/** Refresh-token grant, deliberately without a `resource` parameter. */
async function refreshTokens(refreshToken: string) {
  const res = await exports.default.fetch(
    new Request(`${BASE}/api/auth/oauth2/token`, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        origin: "http://localhost:4173",
      },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: refreshToken,
        client_id: "bulwark-lite",
      }),
    }),
  );
  return { status: res.status, body: (await res.json()) as Json };
}

describe("jmapAuth: app passwords (Basic)", () => {
  let ana: Session;
  let accountIds: string[];
  beforeEach(async () => {
    await resetDb();
    const admin = await bootstrapAdmin();
    const created = await request<Json>("/api/admin/users", {
      method: "POST",
      cookie: admin.cookie,
      json: { name: "Ana", primaryAddress: "ana@example.com", recoveryEmail: "r@example.org" },
    });
    ana = await acceptInvite(created.body.invite.url);
    accountIds = (await request<Json>("/api/me", { cookie: ana.cookie })).body.accounts.map(
      (a: Json) => a.id,
    );
  });

  it("accepts a valid app password and exposes the principal", async () => {
    const key = await createAppPassword(ana);
    expect(key.startsWith("s8s_")).toBe(true);
    const res = await callJmap(basic("Ana@Example.com", key));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ userId: ana.userId, email: "ana@example.com", accountIds });
  });

  it("lists app passwords as {apiKeys} and records last use at most every 10 minutes", async () => {
    await createAppPassword(ana);
    const key = await createAppPassword(ana);
    const before = await request<Json>("/api/auth/api-key/list", { cookie: ana.cookie });
    expect(before.status).toBe(200);
    expect(before.body.apiKeys).toHaveLength(2);
    expect(before.body.apiKeys[0].lastRequest ?? null).toBeNull();
    expect((await callJmap(basic("ana@example.com", key))).status).toBe(200);
    await vi.waitFor(async () => {
      const row = await env.DB.prepare(
        "SELECT count(*) AS n FROM apikey WHERE last_request IS NOT NULL",
      ).first<{ n: number }>();
      expect(row!.n).toBe(1);
    });
    const list = await request<Json>("/api/auth/api-key/list", { cookie: ana.cookie });
    expect(list.body.apiKeys.filter((k: Json) => k.lastRequest)).toHaveLength(1);
  });

  it("stores only a fast hash of the key (not scrypt)", async () => {
    const key = await createAppPassword(ana);
    const row = await env.DB.prepare("SELECT key FROM apikey").first<{ key: string }>();
    expect(row!.key).not.toContain(key);
    expect(row!.key).toMatch(/^[A-Za-z0-9_-]{43}$/); // base64url(sha256)
  });

  it("rejects wrong password, wrong user, malformed and missing credentials with the challenge", async () => {
    const key = await createAppPassword(ana);
    const cases = [
      basic("ana@example.com", key + "x"),
      basic("admin@example.com", key), // someone else's name with Ana's key
      basic("ana@example.com", "ana password"),
      "Basic !!!not-base64",
      basic("ana@example.com", ""),
      "Basic",
      "Digest abc",
      undefined,
    ];
    for (const header of cases) {
      const res = await callJmap(header);
      expect(res.status, String(header)).toBe(401);
      expect(res.headers.get("www-authenticate")).toBe('Bearer, Basic realm="s8s-mail"');
    }
  });

  it("rejects disabled users, disabled keys and expired keys", async () => {
    const key = await createAppPassword(ana);
    await env.DB.prepare("UPDATE apikey SET expires_at = ?")
      .bind(Date.now() - 1000)
      .run();
    expect((await callJmap(basic("ana@example.com", key))).status).toBe(401);
    await env.DB.prepare("UPDATE apikey SET expires_at = NULL, enabled = 0").run();
    expect((await callJmap(basic("ana@example.com", key))).status).toBe(401);
    await env.DB.prepare("UPDATE apikey SET enabled = 1").run();
    expect((await callJmap(basic("ana@example.com", key))).status).toBe(200);
    await env.DB.prepare("UPDATE user SET banned = 1 WHERE email = 'ana@example.com'").run();
    expect((await callJmap(basic("ana@example.com", key))).status).toBe(401);
  });
});

describe("jmapAuth: OAuth access tokens (Bearer)", () => {
  let ana: Session;
  let tokens: { status: number; body: Json };
  beforeAll(async () => {
    await resetDb();
    const admin = await bootstrapAdmin();
    const created = await request<Json>("/api/admin/users", {
      method: "POST",
      cookie: admin.cookie,
      json: { name: "Ana", primaryAddress: "ana@example.com", recoveryEmail: "r@example.org" },
    });
    ana = await acceptInvite(created.body.invite.url);
    tokens = await oauthTokens(ana);
  });

  it("issues tokens via authorization code + PKCE", () => {
    expect(tokens.status).toBe(200);
    expect(tokens.body).toMatchObject({ token_type: "Bearer" });
    expect(tokens.body.access_token).toBeTruthy();
    expect(tokens.body.id_token.split(".")).toHaveLength(3);
    expect(tokens.body.refresh_token).toBeTruthy();
  });

  it("accepts a valid access token", async () => {
    const res = await callJmap(`Bearer ${tokens.body.access_token}`);
    expect(res.status).toBe(200);
    const principal = (await res.json()) as Json;
    expect(principal).toMatchObject({ userId: ana.userId, email: "ana@example.com" });
    expect(principal.accountIds).toHaveLength(1);
  });

  it("rejects tampered, foreign and wrong-type tokens", async () => {
    const t: string = tokens.body.access_token;
    const tampered = t.slice(0, -2) + (t.endsWith("aa") ? "bb" : "aa");
    for (const bad of [
      tampered,
      "garbage",
      `${t}.x.y`,
      tokens.body.id_token,
      tokens.body.refresh_token,
    ]) {
      const res = await callJmap(`Bearer ${bad}`);
      expect(res.status, bad.slice(0, 20)).toBe(401);
      expect(res.headers.get("www-authenticate")).toContain("Bearer");
    }
    // an id_token with a tampered signature
    const [h, p] = tokens.body.id_token.split(".");
    expect((await callJmap(`Bearer ${h}.${p}.AAAA`)).status).toBe(401);
  });

  it("stops working when the user is disabled or the token expires", async () => {
    await env.DB.prepare("UPDATE oauth_access_token SET expires_at = ?")
      .bind(Date.now() - 1000)
      .run();
    expect((await callJmap(`Bearer ${tokens.body.access_token}`)).status).toBe(401);
    await env.DB.prepare("UPDATE oauth_access_token SET expires_at = ?")
      .bind(Date.now() + 60_000)
      .run();
    expect((await callJmap(`Bearer ${tokens.body.access_token}`)).status).toBe(200);
    await env.DB.prepare("UPDATE user SET banned = 1 WHERE email = 'ana@example.com'").run();
    expect((await callJmap(`Bearer ${tokens.body.access_token}`)).status).toBe(401);
  });

  it("only first-party (trusted) clients may reach mail", async () => {
    await env.DB.prepare("UPDATE user SET banned = 0").run();
    await env.DB.prepare("UPDATE oauth_client SET skip_consent = 0").run();
    expect((await callJmap(`Bearer ${tokens.body.access_token}`)).status).toBe(401);
    await env.DB.prepare("UPDATE oauth_client SET skip_consent = 1").run();
    expect((await callJmap(`Bearer ${tokens.body.access_token}`)).status).toBe(200);
  });

  it("verifies JWT access tokens against the local jwks table (iss, aud, exp, client)", async () => {
    await env.DB.prepare("UPDATE user SET banned = 0").run();
    const { getAuth } = await import("../src/auth");
    const auth = await getAuth(env);
    const base = "http://localhost:8787";
    const mint = async (over: Record<string, unknown> = {}) =>
      (
        await auth.api.signJWT({
          body: {
            payload: {
              sub: ana.userId,
              azp: "bulwark-lite",
              aud: `${base}/jmap`,
              iss: `${base}/api/auth`,
              scope: "openid",
              exp: Math.floor(Date.now() / 1000) + 300,
              ...over,
            },
          },
        })
      ).token;
    const call = async (t: string) => (await callJmap(`Bearer ${t}`)).status;

    const good = await mint();
    expect(await call(good)).toBe(200);
    expect(await call(await mint({ aud: `${base}/other` }))).toBe(401);
    expect(await call(await mint({ iss: "https://evil.example" }))).toBe(401);
    expect(await call(await mint({ exp: Math.floor(Date.now() / 1000) - 10 }))).toBe(401);
    expect(await call(await mint({ azp: "unknown-client" }))).toBe(401);
    const [h, p, sig] = good.split(".");
    expect(await call(`${h}.${p}.${sig!.slice(0, -3)}AAA`)).toBe(401);
    expect(await call(`${h}.${btoa(JSON.stringify({ sub: "x" }))}.${sig}`)).toBe(401);
  });

  it("lets a signed-in user read the client's public info for the consent page", async () => {
    const res = await request<Json>("/api/auth/oauth2/public-client?client_id=bulwark-lite", {
      cookie: ana.cookie,
    });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ client_id: "bulwark-lite", client_name: "Webmail" });
    expect(res.body.client_secret).toBeUndefined();
  });
});

describe("jmapAuth: JWT access tokens (resource=<origin>/jmap)", () => {
  let admin: Session;
  let ana: Session;
  let tokens: { status: number; body: Json };

  beforeAll(async () => {
    await resetDb();
    admin = await bootstrapAdmin();
    const created = await request<Json>("/api/admin/users", {
      method: "POST",
      cookie: admin.cookie,
      json: { name: "Ana", primaryAddress: "ana@example.com", recoveryEmail: "r@example.org" },
    });
    ana = await acceptInvite(created.body.invite.url);
    tokens = await oauthTokens(ana, JMAP_RESOURCE);
  });

  it("issues a short-lived JWT access token for the JMAP resource", () => {
    expect(tokens.status).toBe(200);
    const at: string = tokens.body.access_token;
    expect(at.split(".")).toHaveLength(3);
    expect(decodePart(at, 0)).toMatchObject({ alg: "EdDSA", typ: "at+jwt" });
    expect(decodePart(at, 0).kid).toBeTruthy();
    const claims = decodePart(at, 1);
    expect(claims).toMatchObject({
      iss: `${BASE}/api/auth`,
      sub: ana.userId,
      azp: "bulwark-lite",
    });
    expect([claims.aud].flat()).toContain(JMAP_RESOURCE);
    expect(claims.sid).toBeTruthy();
    expect(claims.exp - claims.iat).toBe(600);
    expect(tokens.body.expires_in).toBe(600);
    expect(tokens.body.refresh_token).toBeTruthy();
  });

  it("stores the public signing key as bare JWK JSON keyed by the JWT kid", async () => {
    const kid = decodePart(tokens.body.access_token, 0).kid;
    const row = await env.DB.prepare("SELECT public_key, alg FROM jwks WHERE id = ?")
      .bind(kid)
      .first<{ public_key: string; alg: string }>();
    expect(row!.alg).toBe("EdDSA");
    expect(JSON.parse(row!.public_key)).toMatchObject({ kty: "OKP", crv: "Ed25519" });
  });

  it("accepts the JWT and exposes the principal", async () => {
    const res = await callJmap(bearer(tokens.body.access_token));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ userId: ana.userId, email: "ana@example.com" });
  });

  it("verifies JWTs without Better Auth, and reads jwks and the client only once per isolate", async () => {
    resetJmapAuthCaches();
    const t = bearer(tokens.body.access_token);

    const first = recordingEnv();
    expect((await callJmap(t, first.bindings)).status).toBe(200);
    expect(tablesOf(first.sql)).toEqual([
      "jwks",
      "mail_account",
      "oauth_client",
      "session",
      "user",
    ]);

    // Cached: only the session, user and account reads remain. Better Auth would have built a
    // new instance for this fresh env (WeakMap) and queried oauth_resource, verification, ...
    const second = recordingEnv();
    expect((await callJmap(t, second.bindings)).status).toBe(200);
    expect(tablesOf(second.sql)).toEqual(["mail_account", "session", "user"]);
    expect(second.sql).toHaveLength(3);
  });

  it("reloads the signing keys once for an unknown kid, at most every 30 seconds", async () => {
    const cached = recordingEnv();
    expect((await callJmap(bearer(tokens.body.access_token), cached.bindings)).status).toBe(200);

    // A key added later (rotation), stored the way Better Auth stores it: bare public JWK JSON.
    const { publicKey, privateKey } = await generateKeyPair("EdDSA", {
      crv: "Ed25519",
      extractable: true,
    });
    await env.DB.prepare(
      "INSERT INTO jwks (id, public_key, private_key, created_at, alg, crv) VALUES (?, ?, ?, ?, ?, ?)",
    )
      .bind(
        "rotated-key",
        JSON.stringify(await exportJWK(publicKey)),
        "n/a",
        Date.now(),
        "EdDSA",
        "Ed25519",
      )
      .run();
    const sign = (kid: string, claims: Record<string, unknown> = {}) =>
      new SignJWT({ azp: "bulwark-lite", ...claims })
        .setProtectedHeader({ alg: "EdDSA", kid })
        .setSubject(ana.userId)
        .setIssuer(`${BASE}/api/auth`)
        .setAudience(JMAP_RESOURCE)
        .setExpirationTime("5m")
        .sign(privateKey);
    const rotated = await sign("rotated-key");

    // Too soon after the last load: no D1 read for the jwks table, the token is refused.
    const early = recordingEnv();
    expect((await callJmap(bearer(rotated), early.bindings)).status).toBe(401);
    expect((await callJmap(bearer(await sign("nope")), early.bindings)).status).toBe(401);
    expect(tablesOf(early.sql)).toEqual([]);

    const realNow = Date.now();
    const clock = vi.spyOn(Date, "now").mockReturnValue(realNow + 31_000);
    try {
      const later = recordingEnv();
      expect((await callJmap(bearer(rotated), later.bindings)).status).toBe(200);
      expect(later.sql.filter((q) => q.includes('"jwks"'))).toHaveLength(1);

      // Bad kids right after that reload cannot force another one.
      const spam = recordingEnv();
      for (let i = 0; i < 3; i++) {
        expect((await callJmap(bearer(await sign(`unknown-${i}`)), spam.bindings)).status).toBe(
          401,
        );
      }
      expect(tablesOf(spam.sql)).toEqual([]);
    } finally {
      clock.mockRestore();
    }
    // The signature must match the key the kid names.
    const forged = await sign("rotated-key");
    const [h, p] = forged.split(".");
    const other = tokens.body.access_token.split(".")[2];
    expect((await callJmap(bearer(`${h}.${p}.${other}`))).status).toBe(401);
    await env.DB.prepare("DELETE FROM jwks WHERE id = 'rotated-key'").run();
    resetJmapAuthCaches();
  });

  it("keeps issuing JWTs on refresh even when the client sends no resource", async () => {
    const refreshed = await refreshTokens(tokens.body.refresh_token);
    expect(refreshed.status).toBe(200);
    const at: string = refreshed.body.access_token;
    expect(at.split(".")).toHaveLength(3);
    expect([decodePart(at, 1).aud].flat()).toContain(JMAP_RESOURCE);
    expect((await callJmap(bearer(at))).status).toBe(200);
    // the rotated refresh token keeps working too
    tokens.body.refresh_token = refreshed.body.refresh_token;
    tokens.body.access_token = at;
  });

  it("rejects tokens for another audience, issuer or tampered signature", async () => {
    const { getAuth } = await import("../src/auth");
    const auth = await getAuth(env);
    const mint = async (over: Record<string, unknown> = {}) =>
      (
        await auth.api.signJWT({
          body: {
            payload: {
              sub: ana.userId,
              azp: "bulwark-lite",
              aud: JMAP_RESOURCE,
              iss: `${BASE}/api/auth`,
              exp: Math.floor(Date.now() / 1000) + 300,
              ...over,
            },
          },
        })
      ).token;
    expect((await callJmap(bearer(await mint()))).status).toBe(200);
    expect((await callJmap(bearer(await mint({ aud: `${BASE}/other` })))).status).toBe(401);
    expect((await callJmap(bearer(await mint({ aud: "bulwark-lite" })))).status).toBe(401);
    expect((await callJmap(bearer(await mint({ iss: "https://evil.example" })))).status).toBe(401);
    const t: string = tokens.body.access_token;
    expect((await callJmap(bearer(t.slice(0, -3) + "AAA"))).status).toBe(401);
    // the ID token is a JWT from the same issuer but for the client audience
    const idToken = (await oauthTokens(ana, JMAP_RESOURCE)).body.id_token;
    expect((await callJmap(bearer(idToken))).status).toBe(401);
  });

  it("only issues tokens for the registered resource, and only to clients linked to it", async () => {
    const other = await authorize(ana, `${BASE}/other`);
    expect(other.location.searchParams.get("code")).toBeNull();
    expect(other.location.searchParams.get("error")).toBe("invalid_target");

    await env.DB.prepare("DELETE FROM oauth_client_resource").run();
    const unlinked = await authorize(ana, JMAP_RESOURCE);
    expect(unlinked.location.searchParams.get("error")).toBe("invalid_target");

    // the bootstrap client sync restores the link (idempotently)
    for (let i = 0; i < 2; i++) {
      const ensured = await request("/api/admin/oauth-clients/ensure-defaults", {
        method: "POST",
        cookie: admin.cookie,
        json: {},
      });
      expect(ensured.status).toBe(200);
    }
    const links = await env.DB.prepare("SELECT count(*) AS n FROM oauth_client_resource").first<{
      n: number;
    }>();
    expect(links!.n).toBe(1);
    expect((await oauthTokens(ana, JMAP_RESOURCE)).status).toBe(200);
  });

  it("falls back to opaque access tokens for clients that send no resource", async () => {
    const opaque = await oauthTokens(ana);
    expect(opaque.status).toBe(200);
    expect(opaque.body.access_token.split(".")).toHaveLength(1);
    const res = await callJmap(bearer(opaque.body.access_token));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ userId: ana.userId });
  });

  it("rejects tokens of a client that is not trusted (after the 60 s cache)", async () => {
    const t = bearer((await oauthTokens(ana, JMAP_RESOURCE)).body.access_token);
    expect((await callJmap(t)).status).toBe(200);
    await env.DB.prepare("UPDATE oauth_client SET skip_consent = 0").run();
    expect((await callJmap(t)).status).toBe(200); // cached verdict
    resetJmapAuthCaches();
    expect((await callJmap(t)).status).toBe(401);
    await env.DB.prepare("UPDATE oauth_client SET skip_consent = 1, disabled = 1").run();
    resetJmapAuthCaches();
    expect((await callJmap(t)).status).toBe(401);
    await env.DB.prepare("UPDATE oauth_client SET disabled = 0").run();
    resetJmapAuthCaches();
    expect((await callJmap(t)).status).toBe(200);
  });

  it("rejects a banned user", async () => {
    const t = bearer((await oauthTokens(ana, JMAP_RESOURCE)).body.access_token);
    expect((await callJmap(t)).status).toBe(200);
    await env.DB.prepare("UPDATE user SET banned = 1 WHERE email = 'ana@example.com'").run();
    expect((await callJmap(t)).status).toBe(401);
    await env.DB.prepare("UPDATE user SET banned = 0").run();
    expect((await callJmap(t)).status).toBe(200);
  });

  it("rejects tokens whose session expired or was deleted", async () => {
    const access: string = (await oauthTokens(ana, JMAP_RESOURCE)).body.access_token;
    const t = bearer(access);
    const sid = sidOf(access);
    expect((await callJmap(t)).status).toBe(200);
    await env.DB.prepare("UPDATE session SET expires_at = ? WHERE id = ?")
      .bind(Date.now() - 1000, sid)
      .run();
    expect((await callJmap(t)).status).toBe(401);
    await env.DB.prepare("UPDATE session SET expires_at = ? WHERE id = ?")
      .bind(Date.now() + 3_600_000, sid)
      .run();
    expect((await callJmap(t)).status).toBe(200);
    await env.DB.prepare("DELETE FROM session WHERE id = ?").bind(sid).run();
    expect((await callJmap(t)).status).toBe(401);
  });
});
