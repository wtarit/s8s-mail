import { env, exports } from "cloudflare:workers";
import { Hono } from "hono";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { jmapAuth } from "../src/auth/jmap-auth";
import type { AppEnv } from "../src/auth/types";
import { acceptInvite, bootstrapAdmin, request, resetDb, type Session, type Json } from "./helpers";

vi.mock("../src/send", () => ({ sendSystemMail: vi.fn(async () => {}) }));

// What the JMAP module does: put jmapAuth in front of its routes and read c.var.principal.
const jmap = new Hono<AppEnv>();
jmap.use("*", jmapAuth);
jmap.get("/session", (c) => c.json(c.var.principal));
const callJmap = (authorization?: string) =>
  jmap.fetch(
    new Request("http://localhost:8787/session", {
      headers: authorization ? { authorization } : {},
    }),
    env,
  );

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

/** Authorization-code + PKCE flow against the Bulwark client; returns the token response. */
async function oauthTokens(session: Session) {
  const verifier = b64url(crypto.getRandomValues(new Uint8Array(32)));
  const challenge = b64url(
    new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))),
  );
  const redirect = "http://localhost:4173/oauth/callback";
  const q = new URLSearchParams({
    response_type: "code",
    client_id: "bulwark-lite",
    redirect_uri: redirect,
    scope: "openid profile email offline_access",
    state: "xyz",
    code_challenge: challenge,
    code_challenge_method: "S256",
  });
  const authz = await request(`/api/auth/oauth2/authorize?${q}`, { cookie: session.cookie });
  expect(authz.status).toBe(302);
  const location = new URL(authz.headers.get("location")!);
  expect(location.origin + location.pathname).toBe(redirect);
  expect(location.searchParams.get("state")).toBe("xyz");
  const code = location.searchParams.get("code")!;
  expect(code).toBeTruthy();

  return fetchToken(code, verifier, redirect);
}

async function fetchToken(code: string, verifier: string, redirect: string) {
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
      }),
    }),
  );
  return { status: res.status, body: (await res.json()) as Json, headers: res.headers };
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
