import { exports } from "cloudflare:workers";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { BASE, acceptInvite, bootstrapAdmin, request, type Session, type Json } from "../helpers";
import { callJmap, resetDb, bearer, oauthTokens } from "../helpers/auth-jmap";

vi.mock("../../src/send", () => ({ sendSystemMail: vi.fn(async () => {}) }));

describe("jmapAuth: opaque OAuth access tokens are rejected (Bearer)", () => {
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
    // A flow without `resource`: the provider issues an opaque access token.
    tokens = await oauthTokens(ana);
  });

  it("issues opaque tokens via authorization code + PKCE when no resource is sent", () => {
    expect(tokens.status).toBe(200);
    expect(tokens.body).toMatchObject({ token_type: "Bearer" });
    expect(tokens.body.access_token.split(".")).toHaveLength(1);
    expect(tokens.body.id_token.split(".")).toHaveLength(3);
    expect(tokens.body.refresh_token).toBeTruthy();
  });

  it("rejects an opaque access token with 401", async () => {
    const res = await callJmap(bearer(tokens.body.access_token));
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toContain("Bearer");
    expect(await res.json()).toMatchObject({ title: "Invalid credentials" });
  });

  it("rejects an opaque access token on /jmap/session and /jmap/api", async () => {
    const authorization = bearer(tokens.body.access_token);
    const session = await exports.default.fetch(
      new Request(`${BASE}/jmap/session`, { headers: { authorization } }),
    );
    expect(session.status).toBe(401);
    const api = await exports.default.fetch(
      new Request(`${BASE}/jmap/api`, {
        method: "POST",
        headers: { authorization, "content-type": "application/json" },
        body: JSON.stringify({ using: ["urn:ietf:params:jmap:core"], methodCalls: [] }),
      }),
    );
    expect(api.status).toBe(401);
  });

  it("still serves the opaque token at the provider's userinfo endpoint (SSO apps)", async () => {
    const res = await exports.default.fetch(
      new Request(`${BASE}/api/auth/oauth2/userinfo`, {
        headers: { authorization: bearer(tokens.body.access_token) },
      }),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ sub: ana.userId });
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

  it("lets a signed-in user read the client's public info for the consent page", async () => {
    const res = await request<Json>("/api/auth/oauth2/public-client?client_id=bulwark-lite", {
      cookie: ana.cookie,
    });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ client_id: "bulwark-lite", client_name: "Webmail" });
    expect(res.body.client_secret).toBeUndefined();
  });
});
