import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { cookieFrom, request, resetDb, type Json, type Session } from "../helpers";
import { ageStamps, bootstrapAdmin, stampsOf, userWith, type TestUser } from "../helpers/accounts";
import {
  beginPassword,
  FIRST_PASSWORD,
  login,
  NEXT_PASSWORD,
  sessionId,
  setPassword,
  stepUpPassword,
} from "../helpers/opaque";
import { VirtualPasskey } from "../helpers/passkey";

vi.mock("../../src/send", () => ({ sendSystemMail: vi.fn(async () => {}) }));

const MINUTES = 60 * 1000;
const createAppPassword = (cookie: string) =>
  request("/api/auth/api-key/create", { cookie, json: { name: "Thunderbird" } });
const listPasskeys = async (cookie: string) =>
  (await request<{ id: string }[]>("/api/auth/passkey/list-user-passkeys", { cookie })).body;
const deletePasskey = (cookie: string, id: string) =>
  request("/api/auth/passkey/delete-passkey", { cookie, json: { id } });
const changePassword = async (session: Session, current?: string) => {
  try {
    await setPassword(session, NEXT_PASSWORD, current);
    return { status: 200, body: {} as Json };
  } catch (error) {
    const text = String(error);
    return {
      status: Number(/"status":(\d+)/.exec(text)?.[1]),
      body: JSON.parse(text.slice(text.indexOf("{"))).body,
    };
  }
};

describe("account changes need every factor, fresh", () => {
  let admin: Session;
  beforeEach(async () => {
    await resetDb();
    admin = await bootstrapAdmin();
  });

  describe("error shape", () => {
    it("names the stale factors so the SPA asks for just those", async () => {
      const ana = await userWith(admin, "both");
      await ageStamps(ana.session.cookie, 6 * MINUTES, ["password"]);
      const res = await createAppPassword(ana.session.cookie);
      expect(res.status).toBe(403);
      expect(res.body).toMatchObject({
        code: "REAUTHENTICATION_REQUIRED",
        stale: ["password"],
        oneOf: false,
      });
      await ageStamps(ana.session.cookie, 6 * MINUTES);
      expect((await createAppPassword(ana.session.cookie)).body).toMatchObject({
        stale: ["password", "passkey"],
      });
    });
  });

  describe.each([["password"], ["passkey"], ["both"]] as const)("%s user", (kind) => {
    let ana: TestUser;
    beforeEach(async () => {
      ana = await userWith(admin, kind);
    });

    it("can create an app password right after verifying", async () => {
      expect((await createAppPassword(ana.session.cookie)).status).toBe(200);
    });

    it("cannot after 5 minutes, until every stale factor is verified again", async () => {
      const cookie = ana.session.cookie;
      await ageStamps(cookie, 6 * MINUTES);
      expect((await createAppPassword(cookie)).status).toBe(403);
      if (ana.password) {
        expect((await stepUpPassword(ana.session, ana.password)).status).toBe(200);
        expect((await createAppPassword(cookie)).status).toBe(kind === "both" ? 403 : 200);
      }
      if (ana.passkey) {
        const stepped = await ana.passkey.authenticate(cookie);
        expect(stepped.status).toBe(200);
      }
      expect((await createAppPassword(cookie)).status).toBe(200);
    });

    it("refuses an impersonated session whatever its stamps say", async () => {
      await env.DB.prepare("UPDATE session SET impersonated_by = ? WHERE user_id = ?")
        .bind(admin.userId, ana.userId)
        .run();
      const res = await createAppPassword(ana.session.cookie);
      expect(res.status).toBe(403);
      expect(res.body).toMatchObject({ code: "ACCOUNT_CHANGE_NOT_ALLOWED" });
      expect(
        (await VirtualPasskey.create().then((k) => k.register(ana.session.cookie))).body,
      ).toMatchObject({
        code: "ACCOUNT_CHANGE_NOT_ALLOWED",
      });
    });
  });

  describe("adding and removing passkeys", () => {
    it("adds a passkey only with fresh factors", async () => {
      const ana = await userWith(admin, "password");
      await ageStamps(ana.session.cookie, 6 * MINUTES);
      const key = await VirtualPasskey.create();
      const stale = await key.register(ana.session.cookie);
      expect(stale.status).toBe(403);
      expect(stale.body).toMatchObject({ code: "REAUTHENTICATION_REQUIRED", stale: ["password"] });
      expect((await stepUpPassword(ana.session, FIRST_PASSWORD)).status).toBe(200);
      expect((await key.register(ana.session.cookie)).status).toBe(200);
      // Registering proves the new passkey: the user is now 2FA and the session stays fresh.
      expect(await stampsOf(ana.session.cookie)).toMatchObject({ passkey: expect.any(String) });
      expect((await createAppPassword(ana.session.cookie)).status).toBe(200);
    });

    it("also guards generate-register-options", async () => {
      const ana = await userWith(admin, "passkey");
      await ageStamps(ana.session.cookie, 6 * MINUTES);
      const res = await request("/api/auth/passkey/generate-register-options", {
        cookie: ana.session.cookie,
      });
      expect(res.status).toBe(403);
      expect(res.body).toMatchObject({ stale: ["passkey"] });
    });

    it("refuses removing the last factor, allows removing one of several", async () => {
      const ana = await userWith(admin, "passkey");
      const [only] = await listPasskeys(ana.session.cookie);
      const refused = await deletePasskey(ana.session.cookie, only!.id);
      expect(refused.status).toBe(409);
      expect(refused.body).toMatchObject({ code: "LAST_FACTOR" });
      const second = await VirtualPasskey.create();
      expect((await second.register(ana.session.cookie)).status).toBe(200);
      expect((await deletePasskey(ana.session.cookie, only!.id)).status).toBe(200);
      expect(await listPasskeys(ana.session.cookie)).toHaveLength(1);
      const [last] = await listPasskeys(ana.session.cookie);
      expect((await deletePasskey(ana.session.cookie, last!.id)).status).toBe(409);
    });

    it("lets a 2FA user remove their only passkey (the password remains)", async () => {
      const ana = await userWith(admin, "both");
      const [only] = await listPasskeys(ana.session.cookie);
      expect((await deletePasskey(ana.session.cookie, only!.id)).status).toBe(200);
      expect((await login(ana.email)).body.user.id).toBe(ana.userId);
    });

    it("needs fresh factors to remove a passkey", async () => {
      const ana = await userWith(admin, "both");
      const [only] = await listPasskeys(ana.session.cookie);
      await ageStamps(ana.session.cookie, 6 * MINUTES);
      expect((await deletePasskey(ana.session.cookie, only!.id)).status).toBe(403);
    });

    it("renaming a passkey, listing sessions and deleting app passwords only need a session", async () => {
      const ana = await userWith(admin, "both");
      const key = await createAppPassword(ana.session.cookie);
      const [passkey] = await listPasskeys(ana.session.cookie);
      await ageStamps(ana.session.cookie, 60 * MINUTES);
      expect(
        (
          await request("/api/auth/passkey/update-passkey", {
            cookie: ana.session.cookie,
            json: { id: passkey!.id, name: "Renamed" },
          })
        ).status,
      ).toBe(200);
      expect(
        (await request("/api/auth/list-sessions", { cookie: ana.session.cookie })).status,
      ).toBe(200);
      expect(
        (
          await request("/api/auth/api-key/delete", {
            cookie: ana.session.cookie,
            json: { keyId: key.body.id },
          })
        ).status,
      ).toBe(200);
    });

    it("lists sessions for a session older than Better Auth's default freshness", async () => {
      const ana = await userWith(admin, "password");
      await env.DB.prepare("UPDATE session SET created_at = ? WHERE user_id = ?")
        .bind(Date.now() - 3 * 24 * 60 * MINUTES, ana.userId)
        .run();
      expect(
        (await request("/api/auth/list-sessions", { cookie: ana.session.cookie })).status,
      ).toBe(200);
    });
  });

  describe("changing the password", () => {
    it("always proves the current password in the same exchange", async () => {
      const ana = await userWith(admin, "password");
      const missing = await changePassword(ana.session);
      expect(missing.status).toBe(403);
      expect(missing.body).toMatchObject({ code: "CURRENT_PASSWORD_REQUIRED" });
      const wrong = await changePassword(ana.session, "definitely wrong");
      expect(wrong.status).toBe(401);
      expect((await login(ana.email, FIRST_PASSWORD)).status).toBe(200);
      expect((await changePassword(ana.session, FIRST_PASSWORD)).status).toBe(200);
      expect((await login(ana.email, NEXT_PASSWORD)).status).toBe(200);
    });

    it("a proof is required even right after signing in, and counts as the password verification", async () => {
      const ana = await userWith(admin, "both");
      await ageStamps(ana.session.cookie, 6 * MINUTES, ["password"]);
      const done = await changePassword(ana.session, FIRST_PASSWORD);
      expect(done.status).toBe(200);
      expect((await stampsOf(ana.session.cookie)).password).toBeTruthy();
    });

    it("2FA: a stale passkey still blocks the change, naming only the passkey", async () => {
      const ana = await userWith(admin, "both");
      await ageStamps(ana.session.cookie, 6 * MINUTES, ["passkey"]);
      const refused = await changePassword(ana.session, FIRST_PASSWORD);
      expect(refused.status).toBe(403);
      expect(refused.body).toMatchObject({ code: "REAUTHENTICATION_REQUIRED", stale: ["passkey"] });
    });

    it("revokes other sessions, OAuth tokens, ALL app passwords and pending handshakes in one go", async () => {
      const ana = await userWith(admin, "password");
      const other = await login(ana.email);
      await createAppPassword(ana.session.cookie);
      await createAppPassword(ana.session.cookie);
      const pendingHandshake = await (await import("../helpers/opaque")).beginLogin(ana.email);
      await setPassword(ana.session, NEXT_PASSWORD, FIRST_PASSWORD);
      expect((await request("/api/me", { cookie: other.cookie })).status).toBe(401);
      expect((await request("/api/me", { cookie: ana.session.cookie })).status).toBe(200);
      expect(
        (await env.DB.prepare("SELECT count(*) AS n FROM apikey WHERE reference_id = ?")
          .bind(ana.userId)
          .first<{ n: number }>())!.n,
      ).toBe(0);
      expect(
        (await request("/api/auth/opaque/login/finish", { json: pendingHandshake.body })).status,
      ).toBe(409);
      expect((await login(ana.email, FIRST_PASSWORD)).status).toBe(401);
    });

    it("is refused for a session that was ended while the exchange was in flight", async () => {
      const ana = await userWith(admin, "password");
      const pending = await beginPassword(ana.session, NEXT_PASSWORD, FIRST_PASSWORD);
      await env.DB.prepare("DELETE FROM session WHERE id = ?")
        .bind(await sessionId(ana.session))
        .run();
      const res = await request("/api/auth/opaque/password/finish", {
        cookie: ana.session.cookie,
        json: pending.body,
      });
      expect(res.status).toBe(401);
      expect((await login(ana.email, NEXT_PASSWORD)).status).toBe(401);
    });
  });

  it("an impersonation session made by Better Auth's admin plugin cannot change anything", async () => {
    const ana = await userWith(admin, "both");
    const impersonation = await request("/api/auth/admin/impersonate-user", {
      cookie: admin.cookie,
      json: { userId: ana.userId },
    });
    expect(impersonation.status).toBe(200);
    const cookie = cookieFrom(impersonation.headers);
    expect((await request("/api/me", { cookie })).body.user.accountChange.allowed).toBe(false);
    for (const res of [
      await createAppPassword(cookie),
      await VirtualPasskey.create().then((key) => key.register(cookie)),
      await request("/api/auth/opaque/password/start", {
        cookie,
        json: { registrationRequest: "AAAA" },
      }),
    ]) {
      expect(res.status).toBe(403);
      expect(res.body).toMatchObject({ code: "ACCOUNT_CHANGE_NOT_ALLOWED" });
    }
  });

  it("step-up never starts a new session and leaves other sessions alone", async () => {
    const ana = await userWith(admin, "both");
    const other = await login(ana.email);
    const otherCookie = cookieFrom(
      (
        await ana.passkey!.authenticate(
          other.headers
            .getSetCookie()
            .map((c) => c.split(";")[0])
            .join("; "),
        )
      ).headers,
    );
    const before = (await env.DB.prepare("SELECT count(*) AS n FROM session").first<{
      n: number;
    }>())!.n;
    await ageStamps(ana.session.cookie, 6 * MINUTES);
    const stepped = await ana.passkey!.authenticate(ana.session.cookie);
    expect(stepped.status).toBe(200);
    // The browser keeps its cookie: the reply sets no session cookie.
    expect(cookieFrom(stepped.headers)).not.toContain("session_token");
    expect(
      (await env.DB.prepare("SELECT count(*) AS n FROM session").first<{ n: number }>())!.n,
    ).toBe(before);
    expect((await stampsOf(ana.session.cookie)).passkey).toBeTruthy();
    expect((await request("/api/me", { cookie: otherCookie })).status).toBe(200);
    expect(await sessionId(ana.session)).toBeTruthy();
  });

  it("a stale session cannot step up with another user's passkey", async () => {
    const ana = await userWith(admin, "passkey");
    const bob = await userWith(admin, "passkey", "bob");
    await ageStamps(ana.session.cookie, 6 * MINUTES);
    const res = await bob.passkey!.authenticate(ana.session.cookie);
    // Bob signs himself in; Ana's session is untouched and still stale.
    expect(res.status).toBe(200);
    expect(cookieFrom(res.headers)).toContain("session_token");
    expect((await createAppPassword(ana.session.cookie)).status).toBe(403);
  });
});
