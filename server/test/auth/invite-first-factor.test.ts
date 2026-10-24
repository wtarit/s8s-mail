import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  cookieFrom,
  request,
  resetDb,
  tokenFromInviteUrl,
  type Json,
  type Session,
} from "../helpers";
import {
  acceptInvite,
  acceptInviteWithPasskey,
  ageStamps,
  bootstrapAdmin,
  openInvite,
  stampsOf,
  userWith,
} from "../helpers/accounts";
import { createUser } from "../helpers/admin";
import {
  beginPassword,
  FIRST_PASSWORD,
  login,
  NEXT_PASSWORD,
  setPassword,
} from "../helpers/opaque";
import { VirtualPasskey } from "../helpers/passkey";

vi.mock("../../src/send", () => ({ sendSystemMail: vi.fn(async () => {}) }));

const count = async (table: string, userId: string) =>
  (await env.DB.prepare(`SELECT count(*) AS n FROM ${table} WHERE user_id = ?`)
    .bind(userId)
    .first<{ n: number }>())!.n;
const inviteInfo = (url: string) => request<Json>(`/api/invite/${tokenFromInviteUrl(url)}`);
const finishPassword = (session: Session, body: unknown) =>
  request("/api/auth/opaque/password/finish", { cookie: session.cookie, json: body });

describe("invite: saving the first factor", () => {
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

  describe("saving the first factor", () => {
    it("PASSWORD: uses the invite up and the same session becomes a normal one, password verified", async () => {
      const session = await openInvite(url);
      await setPassword(session, FIRST_PASSWORD);
      expect((await inviteInfo(url)).body.status).toBe("used");
      expect(await stampsOf(session.cookie)).toMatchObject({ inviteId: null, passkey: null });
      expect((await stampsOf(session.cookie)).password).toBeTruthy();
      expect((await request("/api/me", { cookie: session.cookie })).status).toBe(200);
      expect((await login()).status).toBe(200);
    });

    it("PASSKEY: same, with exactly one passkey row and the passkey verified now", async () => {
      const { session, passkey } = await acceptInviteWithPasskey(url);
      expect((await inviteInfo(url)).body.status).toBe("used");
      expect(await count("passkey", userId)).toBe(1);
      expect(await stampsOf(session.cookie)).toMatchObject({ inviteId: null, password: null });
      expect((await stampsOf(session.cookie)).passkey).toBeTruthy();
      expect((await passkey.authenticate()).status).toBe(200);
    });

    it("the second factor can be added right away, or later through step-up", async () => {
      const session = await acceptInvite(url);
      const key = await VirtualPasskey.create();
      expect((await key.register(session.cookie)).status).toBe(200);
      expect((await request("/api/me", { cookie: session.cookie })).body.user).toMatchObject({
        hasPassword: true,
        passkeyCount: 1,
      });
      // Passkey first, the password later (it is a FIRST password: no current-password proof).
      const second = await createUser(admin, { name: "Bob", primaryAddress: "bob@example.com" });
      const bob = await acceptInviteWithPasskey(second.body.invite.url);
      await ageStamps(bob.session.cookie, 6 * 60_000);
      const stale = await beginPassword(bob.session).catch((e: Error) => e);
      expect(String(stale)).toContain("REAUTHENTICATION_REQUIRED");
      expect((await bob.passkey.authenticate(bob.session.cookie)).status).toBe(200);
      await setPassword(bob.session, FIRST_PASSWORD);
      expect((await login("bob@example.com")).body).toMatchObject({ passkeyRequired: true });
    });

    it("is a full reset: old password, passkeys, app passwords, sessions and tokens are gone", async () => {
      // An existing 2FA user with an app password and a second session, then a new invite.
      const bob = await userWith(admin, "both", "bob");
      const other = await login(bob.email);
      expect(other.body.passkeyRequired).toBe(true);
      const extra = cookieFrom(
        (
          await bob.passkey!.authenticate(
            other.headers
              .getSetCookie()
              .map((c) => c.split(";")[0])
              .join("; "),
          )
        ).headers,
      );
      expect(
        (
          await request("/api/auth/api-key/create", {
            cookie: bob.session.cookie,
            json: { name: "k" },
          })
        ).status,
      ).toBe(200);
      const reissued = await request<{ invite: { url: string } }>(
        `/api/admin/users/${bob.userId}/invite`,
        {
          method: "POST",
          cookie: admin.cookie,
          json: {},
        },
      );
      // Nothing changes until the first factor is saved (the admin disables to lock out).
      expect((await request("/api/me", { cookie: extra })).status).toBe(200);
      expect((await login(bob.email)).body).toMatchObject({ passkeyRequired: true });
      const enrollment = await openInvite(reissued.body.invite.url);
      expect((await request("/api/me", { cookie: extra })).status).toBe(200);

      await setPassword(enrollment, NEXT_PASSWORD);

      expect(await count("passkey", bob.userId)).toBe(0);
      expect(
        (await env.DB.prepare("SELECT count(*) AS n FROM apikey WHERE reference_id = ?")
          .bind(bob.userId)
          .first<{ n: number }>())!.n,
      ).toBe(0);
      expect((await request("/api/me", { cookie: extra })).status).toBe(401);
      expect((await request("/api/me", { cookie: bob.session.cookie })).status).toBe(401);
      expect((await request("/api/me", { cookie: enrollment.cookie })).status).toBe(200);
      expect((await login(bob.email, FIRST_PASSWORD)).status).toBe(401);
      expect((await login(bob.email, NEXT_PASSWORD)).status).toBe(200);
    });

    it("a first PASSKEY resets the old password too", async () => {
      const bob = await userWith(admin, "password", "bob");
      const reissued = await request<{ invite: { url: string } }>(
        `/api/admin/users/${bob.userId}/invite`,
        {
          method: "POST",
          cookie: admin.cookie,
          json: {},
        },
      );
      const enrolled = await acceptInviteWithPasskey(reissued.body.invite.url);
      expect(await count("opaque_credential", bob.userId)).toBe(0);
      expect((await login(bob.email, FIRST_PASSWORD)).status).toBe(401);
      expect((await request("/api/me", { cookie: bob.session.cookie })).status).toBe(401);
      expect((await enrolled.passkey.authenticate()).status).toBe(200);
    });
  });

  describe("concurrent use", () => {
    it("two enrollment sessions racing to save a password: exactly one wins", async () => {
      const [a, b] = [await openInvite(url), await openInvite(url)];
      const [pa, pb] = [
        await beginPassword(a, FIRST_PASSWORD),
        await beginPassword(b, NEXT_PASSWORD),
      ];
      const results = await Promise.all([finishPassword(a, pa.body), finishPassword(b, pb.body)]);
      expect(results.map((r) => r.status).filter((s) => s === 200)).toHaveLength(1);
      const loser = results.find((r) => r.status !== 200)!;
      expect([401, 409, 410]).toContain(loser.status);
      expect(await count("opaque_credential", userId)).toBe(1);
      const winner = results[0]!.status === 200 ? FIRST_PASSWORD : NEXT_PASSWORD;
      expect((await login("ana@example.com", winner)).status).toBe(200);
    });

    it("a password and a passkey racing: exactly one first factor is saved", async () => {
      const [a, b] = [await openInvite(url), await openInvite(url)];
      const pa = await beginPassword(a, FIRST_PASSWORD);
      const key = await VirtualPasskey.create();
      const [pw, pk] = await Promise.all([finishPassword(a, pa.body), key.register(b.cookie)]);
      expect([pw.status, pk.status].filter((s) => s === 200)).toHaveLength(1);
      expect((await count("opaque_credential", userId)) + (await count("passkey", userId))).toBe(1);
    });

    it("a second use of a spent invite loses with a clear code", async () => {
      const late = await openInvite(url);
      const pending = await beginPassword(late, NEXT_PASSWORD);
      await acceptInvite(url);
      const res = await finishPassword(late, pending.body);
      expect([401, 409, 410]).toContain(res.status);
      expect((await login("ana@example.com", FIRST_PASSWORD)).status).toBe(200);
      expect((await login("ana@example.com", NEXT_PASSWORD)).status).toBe(401);
    });
  });
});
