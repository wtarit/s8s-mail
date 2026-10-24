import { env } from "cloudflare:workers";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { generateKeyPair, exportJWK, SignJWT } from "jose";
import { resetJmapAuthCaches } from "../../src/auth/jmap-auth";
import { BASE, request, type Session, type Json } from "../helpers";
import { acceptInvite, bootstrapAdmin } from "../helpers/accounts";
import {
  callJmap,
  resetDb,
  recordingEnv,
  tablesOf,
  decodePart,
  bearer,
  sidOf,
  JMAP_RESOURCE,
  authorize,
  oauthTokens,
  refreshTokens,
} from "../helpers/auth-jmap";

vi.mock("../../src/send", () => ({ sendSystemMail: vi.fn(async () => {}) }));

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

  it("accepts the JWT and exposes the principal", async () => {
    const res = await callJmap(bearer(tokens.body.access_token));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ userId: ana.userId, email: "ana@example.com" });
  });

  it("reads the signing keys and the client only once per isolate", async () => {
    resetJmapAuthCaches();
    const t = bearer(tokens.body.access_token);

    const first = recordingEnv();
    expect((await callJmap(t, first.bindings)).status).toBe(200);
    expect(tablesOf(first.sql)).toEqual(expect.arrayContaining(["jwks", "oauth_client"]));

    // Warm isolate: the keys and the client's trust are cached.
    const second = recordingEnv();
    expect((await callJmap(t, second.bindings)).status).toBe(200);
    expect(tablesOf(second.sql)).not.toContain("jwks");
    expect(tablesOf(second.sql)).not.toContain("oauth_client");
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

    // Too soon after the last load: the keys are not read again, the token is refused.
    const early = recordingEnv();
    expect((await callJmap(bearer(rotated), early.bindings)).status).toBe(401);
    expect((await callJmap(bearer(await sign("nope")), early.bindings)).status).toBe(401);
    expect(tablesOf(early.sql)).not.toContain("jwks");

    const realNow = Date.now();
    const clock = vi.spyOn(Date, "now").mockReturnValue(realNow + 31_000);
    try {
      const later = recordingEnv();
      expect((await callJmap(bearer(rotated), later.bindings)).status).toBe(200);
      expect(tablesOf(later.sql)).toContain("jwks");

      // Bad kids right after that reload cannot force another one.
      const spam = recordingEnv();
      for (let i = 0; i < 3; i++) {
        expect((await callJmap(bearer(await sign(`unknown-${i}`)), spam.bindings)).status).toBe(
          401,
        );
      }
      expect(tablesOf(spam.sql)).not.toContain("jwks");
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
    const { getAuth } = await import("../../src/auth");
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
    expect(
      (await callJmap(bearer(await mint({ exp: Math.floor(Date.now() / 1000) - 10 })))).status,
    ).toBe(401);
    expect((await callJmap(bearer(await mint({ azp: "unknown-client" })))).status).toBe(401);
    const [mh, mp, msig] = (await mint()).split(".");
    expect(
      (await callJmap(bearer(`${mh}.${btoa(JSON.stringify({ sub: "x" }))}.${msig}`))).status,
    ).toBe(401);
    expect((await callJmap(bearer(`${mh}.${mp}.${msig!.slice(0, -3)}AAA`))).status).toBe(401);
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

    // the bootstrap client sync restores the link, however often it runs
    for (let i = 0; i < 2; i++) {
      const ensured = await request("/api/admin/oauth-clients/ensure-defaults", {
        method: "POST",
        cookie: admin.cookie,
        json: {},
      });
      expect(ensured.status).toBe(200);
    }
    const clients = await request<Json>("/api/admin/oauth-clients", { cookie: admin.cookie });
    expect(clients.body.clients.map((c: Json) => c.clientId)).toEqual(["bulwark-lite"]);
    expect((await oauthTokens(ana, JMAP_RESOURCE)).status).toBe(200);
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
