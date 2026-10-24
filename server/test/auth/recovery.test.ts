import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { cookieFrom, request, resetDb, type Session } from "../helpers";
import { ageStamps, bootstrapAdmin, stampsOf, userWith } from "../helpers/accounts";
import {
  beginPassword,
  FIRST_PASSWORD,
  login,
  NEXT_PASSWORD,
  setPassword,
} from "../helpers/opaque";
import { VirtualPasskey } from "../helpers/passkey";
import { openMagicLink, requestMagicLink } from "../helpers/recovery";

vi.mock("../../src/send", () => ({ sendSystemMail: vi.fn(async () => {}) }));

const sessionCookie = (headers: Headers) =>
  headers
    .getSetCookie()
    .map((c) => c.split(";")[0]!)
    .filter((c) => c.includes("session_token") && !c.endsWith("="))
    .join("; ");
const pendingCookie = (headers: Headers) =>
  headers
    .getSetCookie()
    .map((c) => c.split(";")[0]!)
    .filter((c) => c.includes("pending_sign_in") && !c.endsWith("="))
    .join("; ");
const startPassword = (cookie: string, current?: string) =>
  beginPassword({ cookie, userId: "" }, NEXT_PASSWORD, current).then(
    (r) => r,
    (e: Error) => e,
  );

describe("recovery link (magic link)", () => {
  let admin: Session;
  beforeEach(async () => {
    await resetDb();
    admin = await bootstrapAdmin();
  });

  it("password-only user: full session with recovery, may set a new password without the old", async () => {
    const ana = await userWith(admin, "password");
    const verify = await openMagicLink(ana.email);
    expect(verify.status).toBe(302);
    const cookie = sessionCookie(verify.headers);
    expect(cookie).toContain("session_token");
    expect(await stampsOf(cookie)).toMatchObject({ password: null, passkey: null });
    expect((await stampsOf(cookie)).recovery).toBeTruthy();
    const me = await request("/api/me", { cookie });
    expect(me.body.user.accountChange).toEqual({
      allowed: true,
      stale: [],
      oneOf: false,
      currentPasswordRequired: false,
    });
    await setPassword({ cookie, userId: ana.userId }, NEXT_PASSWORD);
    expect((await login(ana.email, FIRST_PASSWORD)).status).toBe(401);
    expect((await login(ana.email, NEXT_PASSWORD)).status).toBe(200);
  });

  it("passkey-only user: full session with recovery, may add a passkey", async () => {
    const ana = await userWith(admin, "passkey");
    const verify = await openMagicLink(ana.email);
    const cookie = sessionCookie(verify.headers);
    expect(cookie).toContain("session_token");
    const second = await VirtualPasskey.create();
    expect((await second.register(cookie, "Recovered key")).status).toBe(200);
    expect((await second.authenticate()).status).toBe(200);
  });

  describe("2FA user", () => {
    it("the link alone is only the first half: no session, no JMAP, no OAuth", async () => {
      const ana = await userWith(admin, "both");
      const sessionsBefore = (await env.DB.prepare("SELECT count(*) AS n FROM session").first<{
        n: number;
      }>())!.n;
      const verify = await openMagicLink(
        ana.email,
        "http://localhost:8787/magic-link/verify?next=%2F",
      );
      expect(verify.status).toBe(302);
      // Redirected to the callback WITHOUT an error and without a session cookie.
      expect(verify.headers.get("location")).toBe("http://localhost:8787/magic-link/verify?next=/");
      expect(sessionCookie(verify.headers)).toBe("");
      const pending = pendingCookie(verify.headers);
      expect(pending).toContain("pending_sign_in=");
      expect(
        (await env.DB.prepare("SELECT count(*) AS n FROM session").first<{ n: number }>())!.n,
      ).toBe(sessionsBefore);
      expect((await request("/api/me", { cookie: pending })).status).toBe(401);
      expect((await request("/jmap/session", { cookie: pending })).status).toBe(401);
      const authorize = await request(
        "/api/auth/oauth2/authorize?response_type=code&client_id=bulwark-lite&redirect_uri=http%3A%2F%2Flocalhost%3A4173%2Foauth%2Fcallback&scope=openid&code_challenge=abc&code_challenge_method=S256",
        { cookie: pending },
      );
      expect(authorize.headers.get("location") ?? "").not.toContain("code=");
      expect((await request("/api/auth/pending-sign-in", { cookie: pending })).body).toEqual({
        pending: {
          via: "recovery",
          email: ana.email,
          factors: ["passkey", "password"],
        },
      });
    });

    it("link + passkey: signed in, may set a new password without the old one", async () => {
      const ana = await userWith(admin, "both");
      const pending = pendingCookie((await openMagicLink(ana.email)).headers);
      const done = await ana.passkey!.authenticate(pending);
      expect(done.status).toBe(200);
      const cookie = cookieFrom(done.headers);
      const stamps = await stampsOf(cookie);
      expect(stamps.passkey).toBeTruthy();
      expect(stamps.recovery).toBeTruthy();
      expect(stamps.password).toBeNull();
      const me = await request("/api/me", { cookie });
      expect(me.body.user.accountChange).toMatchObject({
        allowed: true,
        currentPasswordRequired: false,
      });
      await setPassword({ cookie, userId: ana.userId }, NEXT_PASSWORD);
      expect((await login(ana.email, NEXT_PASSWORD)).body).toMatchObject({ passkeyRequired: true });
    });

    it("link + password: signed in, may manage passkeys", async () => {
      const ana = await userWith(admin, "both");
      const pending = pendingCookie((await openMagicLink(ana.email)).headers);
      const { beginLogin } = await import("../helpers/opaque");
      const proof = await beginLogin(ana.email, FIRST_PASSWORD);
      const done = await request("/api/auth/opaque/login/finish", {
        json: proof.body,
        cookie: pending,
      });
      expect(done.status).toBe(200);
      expect(done.body.user.id).toBe(ana.userId);
      const cookie = sessionCookie(done.headers);
      const stamps = await stampsOf(cookie);
      expect(stamps.password).toBeTruthy();
      expect(stamps.recovery).toBeTruthy();
      expect(stamps.passkey).toBeNull();
      const replacement = await VirtualPasskey.create();
      expect((await replacement.register(cookie, "New phone")).status).toBe(200);
    });

    it("the pending recovery is single use and expires", async () => {
      const ana = await userWith(admin, "both");
      const pending = pendingCookie((await openMagicLink(ana.email)).headers);
      expect((await ana.passkey!.authenticate(pending)).status).toBe(200);
      const replay = await ana.passkey!.authenticate(pending);
      expect((await stampsOf(cookieFrom(replay.headers))).recovery).toBeNull();
      const second = pendingCookie((await openMagicLink(ana.email)).headers);
      await env.DB.prepare("UPDATE pending_sign_in SET expires_at = ?")
        .bind(Date.now() - 1)
        .run();
      const late = await ana.passkey!.authenticate(second);
      expect((await stampsOf(cookieFrom(late.headers))).recovery).toBeNull();
    });
  });

  it("a user with no factors is not signed in by the link", async () => {
    const created = await request<{ user: { email: string } }>("/api/admin/users", {
      method: "POST",
      cookie: admin.cookie,
      json: { name: "New", primaryAddress: "new@example.com", recoveryEmail: "new.r@example.org" },
    });
    expect(created.status).toBe(201);
    const verify = await openMagicLink("new@example.com");
    expect(sessionCookie(verify.headers)).toBe("");
    expect(pendingCookie(verify.headers)).toBe("");
    expect(verify.headers.get("location")).toContain("error=");
    expect(
      (await env.DB.prepare("SELECT count(*) AS n FROM pending_sign_in").first<{ n: number }>())!.n,
    ).toBe(0);
  });

  it("the link is single use", async () => {
    const ana = await userWith(admin, "password");
    const path = await requestMagicLink(ana.email);
    expect(sessionCookie((await request(path)).headers)).toContain("session_token");
    expect(sessionCookie((await request(path)).headers)).toBe("");
  });

  it("recovery only stands in for a factor for 5 minutes", async () => {
    const ana = await userWith(admin, "password");
    const cookie = sessionCookie((await openMagicLink(ana.email)).headers);
    await ageStamps(cookie, 6 * 60 * 1000);
    const late = await startPassword(cookie);
    expect(String(late)).toContain("REAUTHENTICATION_REQUIRED");
    const me = await request("/api/me", { cookie });
    expect(me.body.user.accountChange).toMatchObject({ allowed: false, stale: ["password"] });
  });
});
