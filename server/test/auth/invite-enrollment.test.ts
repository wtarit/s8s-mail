import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { request, resetDb, tokenFromInviteUrl, type Json, type Session } from "../helpers";
import { acceptInvite, bootstrapAdmin, openInvite, stampsOf, userWith } from "../helpers/accounts";
import { createUser } from "../helpers/admin";
import { beginPassword, FIRST_PASSWORD, login, setPassword } from "../helpers/opaque";

vi.mock("../../src/send", () => ({ sendSystemMail: vi.fn(async () => {}) }));

const count = async (table: string, userId: string) =>
  (await env.DB.prepare(`SELECT count(*) AS n FROM ${table} WHERE user_id = ?`)
    .bind(userId)
    .first<{ n: number }>())!.n;
const inviteInfo = (url: string) => request<Json>(`/api/invite/${tokenFromInviteUrl(url)}`);
const finishPassword = (session: Session, body: unknown) =>
  request("/api/auth/opaque/password/finish", { cookie: session.cookie, json: body });

describe("invite enrollment", () => {
  let admin: Session;
  let url: string;
  let userId: string;
  beforeEach(async () => {
    await resetDb();
    admin = await bootstrapAdmin();
    const created = await createUser(admin);
    url = created.body.invite.url;
    userId = created.body.user.id;
  });

  describe("opening the link does not use it up", () => {
    it("starts an enrollment-only session and leaves the invite valid", async () => {
      const session = await openInvite(url);
      expect(session.userId).toBe(userId);
      expect((await inviteInfo(url)).body.status).toBe("valid");
      expect((await stampsOf(session.cookie)).inviteId).toBeTruthy();
      const row = await env.DB.prepare("SELECT used_at, claim_id FROM invite WHERE user_id = ?")
        .bind(userId)
        .first<Json>();
      expect(row).toMatchObject({ used_at: null, claim_id: null });
      // Nothing was saved: still no sign-in method, the account is still "invited".
      expect(await count("opaque_credential", userId)).toBe(0);
      expect(
        (await request("/api/admin/users", { cookie: admin.cookie })).body.users,
      ).toContainEqual(expect.objectContaining({ id: userId, status: "invited" }));
    });

    it("can be opened again, on another device, days later, with no 5-minute window", async () => {
      const first = await openInvite(url);
      await env.DB.prepare("UPDATE session SET created_at = ?, updated_at = ? WHERE user_id = ?")
        .bind(Date.now() - 3 * 24 * 3600_000, Date.now() - 3 * 24 * 3600_000, userId)
        .run();
      // The three-day-old enrollment session still saves the first factor ...
      const second = await openInvite(url);
      expect(second.cookie).not.toBe(first.cookie);
      await setPassword(first, FIRST_PASSWORD);
      // ... which then uses the invite up for everyone.
      expect((await inviteInfo(url)).body.status).toBe("used");
    });

    it("leave and return: abandoning the page loses nothing", async () => {
      await openInvite(url); // browser closed here, cookie lost
      const back = await openInvite(url);
      await setPassword(back, FIRST_PASSWORD);
      expect((await login()).status).toBe(200);
    });
  });

  describe("an unusable invite says so", () => {
    it("expired: info says expired, opening is refused, an open session can no longer enroll", async () => {
      const early = await openInvite(url);
      const pending = await beginPassword(early);
      await env.DB.prepare("UPDATE invite SET expires_at = ?")
        .bind(Date.now() - 1)
        .run();
      expect((await inviteInfo(url)).body.status).toBe("expired");
      const reopen = await request(`/api/invite/${tokenFromInviteUrl(url)}/session`, {
        method: "POST",
        json: {},
      });
      expect(reopen.status).toBe(410);
      expect(reopen.body).toMatchObject({ error: { code: "invite_expired" } });
      const late = await finishPassword(early, pending.body);
      expect(late.status).toBe(410);
      expect(late.body).toMatchObject({ code: "INVITE_UNAVAILABLE" });
      expect(await count("opaque_credential", userId)).toBe(0);
    });

    it("used: info says used and opening is refused with a clear code", async () => {
      await acceptInvite(url);
      expect((await inviteInfo(url)).body.status).toBe("used");
      const reopen = await request(`/api/invite/${tokenFromInviteUrl(url)}/session`, {
        method: "POST",
        json: {},
      });
      expect(reopen.status).toBe(409);
      expect(reopen.body).toMatchObject({ error: { code: "invite_used" } });
    });

    it("a disabled account cannot open its invite", async () => {
      await request(`/api/admin/users/${userId}`, {
        method: "PATCH",
        cookie: admin.cookie,
        json: { disabled: true },
      });
      const res = await request(`/api/invite/${tokenFromInviteUrl(url)}/session`, {
        method: "POST",
        json: {},
      });
      expect(res.status).toBe(403);
    });

    it("a reissued invite kills the old link and its enrollment sessions", async () => {
      const old = await openInvite(url);
      const fresh = await request<{ invite: { url: string } }>(
        `/api/admin/users/${userId}/invite`,
        {
          method: "POST",
          cookie: admin.cookie,
          json: {},
        },
      );
      expect(fresh.status).toBe(200);
      expect((await inviteInfo(url)).status).toBe(404);
      expect((await request("/api/auth/get-session", { cookie: old.cookie })).body).toBeNull();
      await setPassword(await openInvite(fresh.body.invite.url), FIRST_PASSWORD);
    });
  });

  describe("an enrollment session reaches nothing but the first-factor setup", () => {
    let session: Session;
    beforeEach(async () => {
      session = await openInvite(url);
    });

    it.each([
      ["GET", "/api/me"],
      ["GET", "/api/auth/list-sessions"],
      ["POST", "/api/auth/api-key/create"],
      ["GET", "/api/auth/api-key/list"],
      ["POST", "/api/auth/step-up/password/start"],
      ["GET", "/api/auth/passkey/list-user-passkeys"],
      ["POST", "/api/auth/passkey/delete-passkey"],
      ["POST", "/api/auth/revoke-other-sessions"],
      ["GET", "/api/admin/users"],
    ])("%s %s is refused", async (method, path) => {
      const res = await request(path, {
        method,
        cookie: session.cookie,
        ...(method === "POST" ? { json: { name: "x", id: "x", startLoginRequest: "AAAA" } } : {}),
      });
      expect(res.status).toBe(403);
      expect(JSON.stringify(res.body)).toMatch(/ENROLLMENT_SESSION_ONLY|enrollment_only/);
    });

    it("has no JMAP and no OAuth: no authorization code, no token, no userinfo", async () => {
      expect((await request("/jmap/session", { cookie: session.cookie })).status).toBe(401);
      const authorize = await request(
        "/api/auth/oauth2/authorize?response_type=code&client_id=bulwark-lite&redirect_uri=http%3A%2F%2Flocalhost%3A4173%2Foauth%2Fcallback&scope=openid&code_challenge=abc&code_challenge_method=S256",
        { cookie: session.cookie },
      );
      expect(authorize.status).toBe(403);
      expect(authorize.headers.get("location") ?? "").not.toContain("code=");
      expect([401, 403]).toContain(
        (await request("/api/auth/oauth2/userinfo", { cookie: session.cookie })).status,
      );
    });

    it("can sign in normally in the same browser (the cookie does not block public sign-in)", async () => {
      const ana = await userWith(admin, "password", "bob");
      expect((await login(ana.email)).status).toBe(200);
    });
  });
});
