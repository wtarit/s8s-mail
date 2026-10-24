import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { client } from "../../src/auth/.generated/opaque-worker.mjs";
import { request, resetDb, type Session } from "../helpers";
import { acceptInvite, bootstrapAdmin } from "../helpers/accounts";
import { createUser } from "../helpers/admin";
import {
  beginLogin,
  beginPassword,
  login,
  sessionId,
  FIRST_PASSWORD,
  NEXT_PASSWORD,
} from "../helpers/opaque";

vi.mock("../../src/send", () => ({ sendSystemMail: vi.fn(async () => {}) }));

const finish = (session: Session, body: unknown) =>
  request("/api/auth/opaque/password/finish", { cookie: session.cookie, json: body });
const startWithoutProof = (session: Session) =>
  request("/api/auth/opaque/password/start", {
    cookie: session.cookie,
    json: {
      registrationRequest: client.startRegistration({ password: NEXT_PASSWORD })
        .registrationRequest,
    },
  });

describe("OPAQUE credential replacement", () => {
  let admin: Session;
  let ana: Session;
  beforeEach(async () => {
    await resetDb();
    admin = await bootstrapAdmin();
    ana = await acceptInvite((await createUser(admin)).body.invite.url);
  });

  it("the invite saved the first password; the account is active and can sign in", async () => {
    expect((await request("/api/me", { cookie: ana.cookie })).body.user.hasPassword).toBe(true);
    expect((await login()).status).toBe(200);
    expect((await request("/api/admin/users", { cookie: admin.cookie })).body.users).toContainEqual(
      expect.objectContaining({ id: ana.userId, status: "active" }),
    );
  });

  it("never replaces a password without proving the current one (no exception for a fresh session)", async () => {
    const refused = await startWithoutProof(ana);
    expect(refused.status).toBe(403);
    expect(refused.body).toMatchObject({ code: "CURRENT_PASSWORD_REQUIRED" });
    expect((await login()).status).toBe(200);
  });

  it("verifies the current password and rejects omitted or incorrect proof", async () => {
    const incorrect = await beginPassword(ana, NEXT_PASSWORD, "wrong current password");
    expect(incorrect.currentAccepted).toBe(false);
    expect((await finish(ana, incorrect.body)).status).toBe(401);
    const missing = await beginPassword(ana, NEXT_PASSWORD, FIRST_PASSWORD);
    expect(missing.currentAccepted).toBe(true);
    expect((await finish(ana, { ...missing.body, finishLoginRequest: undefined })).status).toBe(
      401,
    );
    expect((await login()).status).toBe(200);
  });

  it("allows one concurrent change per session and rejects its exact replay", async () => {
    const first = await beginPassword(ana, NEXT_PASSWORD, FIRST_PASSWORD);
    const second = await beginPassword(ana, "third password value 789", FIRST_PASSWORD);
    const results = await Promise.all([first, second].map((p) => finish(ana, p.body)));
    expect(results.map((r) => r.status).toSorted()).toEqual([200, 409]);
    expect((await finish(ana, first.body)).status).toBe(409);
    const winner = results[0]!.status === 200 ? NEXT_PASSWORD : "third password value 789";
    expect((await login("ana@example.com", winner)).status).toBe(200);
  });

  it("binds replacement to the initiating session and the password purpose", async () => {
    const other = await login();
    const otherSession = { cookie: other.cookie, userId: ana.userId };
    const pending = await beginPassword(ana, NEXT_PASSWORD, FIRST_PASSWORD);
    expect((await finish(otherSession, pending.body)).status).toBe(409);
    // A failed cross-session attempt must not consume the legitimate challenge.
    expect((await finish(ana, pending.body)).status).toBe(200);
    const loginProof = await beginLogin("ana@example.com", NEXT_PASSWORD);
    const again = await beginPassword(ana, FIRST_PASSWORD, NEXT_PASSWORD);
    expect(
      (await finish(ana, { ...again.body, challengeId: loginProof.body.challengeId })).status,
    ).toBe(409);
  });

  it("changes the password, revokes other sessions and invalidates in-flight old proofs", async () => {
    const other = await login();
    const stale = await beginLogin("ana@example.com");
    const change = await beginPassword(ana, NEXT_PASSWORD, FIRST_PASSWORD);
    expect((await finish(ana, change.body)).status).toBe(200);
    expect((await request("/api/me", { cookie: other.cookie })).status).toBe(401);
    expect((await request("/api/me", { cookie: ana.cookie })).status).toBe(200);
    expect((await request("/api/auth/opaque/login/finish", { json: other.proof })).status).toBe(
      409,
    );
    expect((await request("/api/auth/opaque/login/finish", { json: stale.body })).status).toBe(409);
    expect((await login()).status).toBe(401);
    expect((await login("ana@example.com", NEXT_PASSWORD)).status).toBe(200);
  });

  it("rejects expired replacement challenges", async () => {
    const pending = await beginPassword(ana, NEXT_PASSWORD, FIRST_PASSWORD);
    await env.DB.prepare("UPDATE opaque_challenge SET expires_at = ? WHERE id = ?")
      .bind(Date.now() - 1, pending.body.challengeId)
      .run();
    expect((await finish(ana, pending.body)).status).toBe(409);
  });

  it("refuses impersonated sessions", async () => {
    await env.DB.prepare("UPDATE session SET impersonated_by = ? WHERE id = ?")
      .bind(admin.userId, await sessionId(ana))
      .run();
    const res = await startWithoutProof(ana);
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ code: "ACCOUNT_CHANGE_NOT_ALLOWED" });
  });

  it("rejects unauthenticated requests and every legacy password endpoint with 404", async () => {
    const registrationRequest = client.startRegistration({
      password: FIRST_PASSWORD,
    }).registrationRequest;
    expect(
      (await request("/api/auth/opaque/password/start", { json: { registrationRequest } })).status,
    ).toBe(401);
    expect((await request("/api/auth/opaque/config")).status).toBe(404);
    for (const path of [
      "sign-in/email",
      "sign-up/email",
      "set-password",
      "set-password/",
      "set%2Dpassword",
      "SET-PASSWORD",
      "change-password",
      "request-password-reset",
      "reset-password",
      "forget-password",
      "admin/set-user-password",
      "admin/create-user",
    ]) {
      const response = await request(`/api/auth/${path}`, {
        cookie: admin.cookie,
        json: {
          name: "Stranger",
          email: "stranger@example.com",
          password: FIRST_PASSWORD,
          newPassword: FIRST_PASSWORD,
          userId: ana.userId,
        },
      });
      expect(response.status, path).toBe(404);
    }
    expect(
      (await env.DB.prepare("SELECT id FROM user WHERE email = 'stranger@example.com'").all())
        .results,
    ).toHaveLength(0);
  });
});
