import { exports } from "cloudflare:workers";
import { describe, expect, it, vi } from "vitest";
import { BASE, request, type Json } from "./helpers";

vi.mock("../src/send", () => ({ sendSystemMail: vi.fn(async () => {}) }));

const WEBMAIL = "http://localhost:4173";

describe("OIDC discovery at the origin root", () => {
  it("serves openid-configuration with the provider's endpoints", async () => {
    const res = await request<Json>("/.well-known/openid-configuration", {
      headers: { origin: WEBMAIL },
    });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      issuer: `${BASE}/api/auth`,
      authorization_endpoint: `${BASE}/api/auth/oauth2/authorize`,
      token_endpoint: `${BASE}/api/auth/oauth2/token`,
      userinfo_endpoint: `${BASE}/api/auth/oauth2/userinfo`,
      jwks_uri: `${BASE}/api/auth/jwks`,
      code_challenge_methods_supported: ["S256"],
    });
    expect(res.body.scopes_supported).toEqual(["openid", "profile", "email", "offline_access"]);
    // no dynamic client registration
    expect(res.body.registration_endpoint).toBeUndefined();
  });

  it("serves oauth-authorization-server at the root and the RFC 8414 path-inserted form", async () => {
    for (const path of [
      "/.well-known/oauth-authorization-server",
      "/.well-known/oauth-authorization-server/api/auth",
    ]) {
      const res = await request<Json>(path);
      expect(res.status, path).toBe(200);
      expect(res.body.token_endpoint).toBe(`${BASE}/api/auth/oauth2/token`);
    }
  });

  it("also serves the issuer-relative path used by OIDC discovery", async () => {
    const res = await request<Json>("/api/auth/.well-known/openid-configuration");
    expect(res.status).toBe(200);
    expect(res.body.issuer).toBe(`${BASE}/api/auth`);
  });

  it("allows only the webmail origin via CORS", async () => {
    for (const path of [
      "/.well-known/openid-configuration",
      "/.well-known/oauth-authorization-server",
      "/api/auth/jwks",
    ]) {
      const ok = await request(path, { headers: { origin: WEBMAIL } });
      expect(ok.headers.get("access-control-allow-origin"), path).toBe(WEBMAIL);
      const other = await request(path, { headers: { origin: "https://evil.example" } });
      expect(other.headers.get("access-control-allow-origin"), path).toBeNull();
    }
  });

  it("answers preflights for the token endpoint and /jmap with Authorization allowed", async () => {
    for (const path of ["/api/auth/oauth2/token", "/api/auth/oauth2/userinfo", "/jmap/session"]) {
      const res = await exports.default.fetch(
        new Request(BASE + path, {
          method: "OPTIONS",
          headers: {
            origin: WEBMAIL,
            "access-control-request-method": "POST",
            "access-control-request-headers": "authorization,content-type",
          },
        }),
      );
      expect(res.status, path).toBe(204);
      expect(res.headers.get("access-control-allow-origin"), path).toBe(WEBMAIL);
      expect(res.headers.get("access-control-allow-headers")!.toLowerCase(), path).toContain(
        "authorization",
      );
      // Bearer tokens, not cookies
      expect(res.headers.get("access-control-allow-credentials"), path).toBeNull();
    }
  });

  it("serves the JWKS directly (keys are generated on first use)", async () => {
    const res = await request<Json>("/api/auth/jwks");
    expect(res.status).toBe(200);
    expect(res.body.keys[0]).toMatchObject({ kty: "OKP", crv: "Ed25519" });
  });
});
