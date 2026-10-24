import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { cookieFrom, request, resetDb, type Session } from "../helpers";
import { bootstrapAdmin, stampsOf, userWith, type TestUser } from "../helpers/accounts";
import { beginLogin, login } from "../helpers/opaque";

vi.mock("../../src/send", () => ({ sendSystemMail: vi.fn(async () => {}) }));

const hasSession = (headers: Headers) => cookieFrom(headers).includes("session_token");
const pendingOf = (headers: Headers) =>
  headers
    .getSetCookie()
    .map((c) => c.split(";")[0]!)
    .filter((c) => c.includes("pending_sign_in") && !c.endsWith("="))
    .join("; ");

describe("sign-in by factor combination", () => {
  let admin: Session;
  beforeEach(async () => {
    await resetDb();
    admin = await bootstrapAdmin();
  });

  it("password-only user: the password signs in, stamping only the password", async () => {
    const ana = await userWith(admin, "password");
    const res = await login(ana.email);
    expect(res.status).toBe(200);
    expect(res.body.user.id).toBe(ana.userId);
    const stamps = await stampsOf(res.cookie);
    expect(stamps.password).toBeTruthy();
    expect(stamps.passkey).toBeNull();
    expect(stamps.recovery).toBeNull();
  });

  it("passkey-only user: a passkey signs in, stamping only the passkey", async () => {
    const ana = await userWith(admin, "passkey");
    const res = await ana.passkey!.authenticate();
    expect(res.status).toBe(200);
    const stamps = await stampsOf(cookieFrom(res.headers));
    expect(stamps.passkey).toBeTruthy();
    expect(stamps.password).toBeNull();
  });

  it("2FA user: a passkey alone signs in", async () => {
    const ana = await userWith(admin, "both");
    const res = await ana.passkey!.authenticate();
    expect(res.status).toBe(200);
    const stamps = await stampsOf(cookieFrom(res.headers));
    expect(stamps.passkey).toBeTruthy();
    expect(stamps.password).toBeNull();
  });

  describe("2FA user and the password", () => {
    let ana: TestUser;
    beforeEach(async () => {
      ana = await userWith(admin, "both");
    });

    it("creates NO session; it answers passkeyRequired and leaves a pending sign-in", async () => {
      const sessionsBefore = await env.DB.prepare("SELECT count(*) AS n FROM session").first<{
        n: number;
      }>();
      const res = await login(ana.email);
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ passkeyRequired: true, redirect: false });
      expect(hasSession(res.headers)).toBe(false);
      const pending = pendingOf(res.headers);
      expect(pending).toContain("pending_sign_in=");
      expect(res.headers.getSetCookie().join(";")).toMatch(/HttpOnly/i);
      const sessionsAfter = await env.DB.prepare("SELECT count(*) AS n FROM session").first<{
        n: number;
      }>();
      expect(sessionsAfter!.n).toBe(sessionsBefore!.n);
      // Nothing is reachable with the pending cookie alone.
      expect((await request("/api/me", { cookie: pending })).status).toBe(401);
      expect((await request("/jmap/session", { cookie: pending })).status).toBe(401);
      const state = await request("/api/auth/pending-sign-in", { cookie: pending });
      expect(state.body).toEqual({
        pending: { via: "password", email: ana.email, factors: ["passkey"] },
      });
    });

    it("the passkey then creates the session with BOTH factors stamped", async () => {
      const pending = pendingOf((await login(ana.email)).headers);
      const done = await ana.passkey!.authenticate(pending);
      expect(done.status).toBe(200);
      expect(hasSession(done.headers)).toBe(true);
      const stamps = await stampsOf(cookieFrom(done.headers));
      expect(stamps.password).toBeTruthy();
      expect(stamps.passkey).toBeTruthy();
      expect(stamps.recovery).toBeNull();
      const me = await request("/api/me", { cookie: cookieFrom(done.headers) });
      expect(me.body.user.accountChange).toMatchObject({ allowed: true, stale: [] });
    });

    it("a pending sign-in is single use and bound to its browser", async () => {
      const pending = pendingOf((await login(ana.email)).headers);
      const first = await ana.passkey!.authenticate(pending);
      expect(stampsOfBody(first).password).toBeTruthy();
      // The row is gone: replaying the cookie only signs in with the passkey.
      const replay = await ana.passkey!.authenticate(pending);
      const stamps = await stampsOf(cookieFrom(replay.headers));
      expect(stamps.password).toBeNull();
      // Without the cookie there is no second factor to merge.
      const bare = await login(ana.email);
      const other = await ana.passkey!.authenticate();
      expect((await stampsOf(cookieFrom(other.headers))).password).toBeNull();
      expect(bare.body.passkeyRequired).toBe(true);
    });

    it("an expired pending sign-in no longer counts", async () => {
      const pending = pendingOf((await login(ana.email)).headers);
      await env.DB.prepare("UPDATE pending_sign_in SET expires_at = ?")
        .bind(Date.now() - 1)
        .run();
      expect((await request("/api/auth/pending-sign-in", { cookie: pending })).body).toEqual({
        pending: null,
      });
      const done = await ana.passkey!.authenticate(pending);
      expect((await stampsOf(cookieFrom(done.headers))).password).toBeNull();
    });

    it("another user's passkey does not pick up the pending password", async () => {
      const bob = await userWith(admin, "passkey", "bob");
      const pending = pendingOf((await login(ana.email)).headers);
      const done = await bob.passkey!.authenticate(pending);
      expect((await stampsOf(cookieFrom(done.headers))).password).toBeNull();
      // Ana's pending sign-in is still intact.
      const mine = await ana.passkey!.authenticate(pending);
      expect((await stampsOf(cookieFrom(mine.headers))).password).toBeTruthy();
    });

    it("a wrong password reveals nothing and creates no pending sign-in", async () => {
      const res = await login(ana.email, "not the password");
      expect(res.status).toBe(401);
      expect(pendingOf(res.headers)).toBe("");
    });

    it("the handshake cannot be finished twice (two racing finishes, one winner)", async () => {
      const proof = await beginLogin(ana.email);
      const [a, b] = await Promise.all(
        [1, 2].map(() => request("/api/auth/opaque/login/finish", { json: proof.body })),
      );
      expect([a!.status, b!.status].toSorted()).toEqual([200, 409]);
    });
  });
});

function stampsOfBody(res: { body: { session: Record<string, string | null> } }) {
  return {
    password: res.body.session.passwordVerifiedAt,
    passkey: res.body.session.passkeyVerifiedAt,
  };
}
