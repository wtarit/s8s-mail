import { describe, expect, it } from "vitest";
import { configureApiBase } from "@/lib/api-base";
import {
  hasSignedOAuthQuery,
  isOAuthResumeUrl,
  loginPath,
  oauthResumeUrl,
  safeNextPath,
} from "@/lib/navigation";
import { parseUserAgent } from "@/lib/user-agent";

describe("navigation helpers", () => {
  it("only accepts same-origin relative next paths", () => {
    expect(safeNextPath("/admin/users")).toBe("/admin/users");
    expect(safeNextPath("//evil.example.net")).toBe("/account/profile");
    expect(safeNextPath("https://evil.example.net")).toBe("/account/profile");
    expect(safeNextPath("/\\evil.example.net")).toBe("/account/profile");
    expect(safeNextPath(null, "/x")).toBe("/x");
  });

  it("builds login URLs that carry next", () => {
    expect(loginPath("/account/passkeys")).toBe("/login?next=%2Faccount%2Fpasskeys");
    expect(loginPath("//evil.example.net")).toBe("/login");
    expect(loginPath()).toBe("/login");
  });

  it("recognises a signed OAuth query and rebuilds the authorize URL", () => {
    configureApiBase("https://mail.example.com");
    const search =
      "?client_id=c1&scope=openid&prompt=login+consent&max_age=0&exp=1&ba_iat=2&ba_param=client_id&sig=zz";
    expect(hasSignedOAuthQuery(search)).toBe(true);
    expect(hasSignedOAuthQuery("?client_id=c1")).toBe(false);
    const url = new URL(oauthResumeUrl(search));
    expect(url.origin).toBe("https://mail.example.com");
    expect(url.pathname).toBe("/api/auth/oauth2/authorize");
    expect(url.searchParams.get("prompt")).toBe("consent");
    expect(url.searchParams.has("max_age")).toBe(false);
    expect(url.searchParams.has("sig")).toBe(false);
    expect(isOAuthResumeUrl(url.toString())).toBe(true);
    expect(isOAuthResumeUrl("https://evil.example.net/api/auth/oauth2/authorize?x=1")).toBe(false);
    expect(isOAuthResumeUrl("https://mail.example.com/other")).toBe(false);
    configureApiBase("");
  });
});

describe("parseUserAgent", () => {
  it("labels common browsers and systems", () => {
    expect(
      parseUserAgent(
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0 Safari/537.36 Edg/120.0",
      ),
    ).toEqual({ browser: "Edge", os: "Windows" });
    expect(parseUserAgent(null)).toEqual({ browser: null, os: null });
  });
});
