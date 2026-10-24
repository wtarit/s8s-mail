import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { getAuth } from "../../src/auth";
import { cookieFrom, request, resetDb, type Session } from "../helpers";
import { acceptInvite, bootstrapAdmin } from "../helpers/accounts";
import { createUser } from "../helpers/admin";
import { beginLogin, beginPassword, login, FIRST_PASSWORD, NEXT_PASSWORD } from "../helpers/opaque";

vi.mock("../../src/send", () => ({ sendSystemMail: vi.fn(async () => {}) }));

describe("OPAQUE login", () => {
  let admin: Session;
  let ana: Session;
  beforeEach(async () => {
    await resetDb();
    admin = await bootstrapAdmin();
    const created = await createUser(admin);
    expect(created.status).toBe(201);
    ana = await acceptInvite(created.body.invite.url);
  });

  it("uses a verified OPAQUE proof to issue an ordinary Better Auth session", async () => {
    const response = await login("Ana@Example.com");
    expect(response.status).toBe(200);
    expect(response.accepted).toBe(true);
    expect(response.cookie).toContain("better-auth.session_token=");
    expect(response.headers.get("cache-control")).toContain("no-store");
    expect((await request("/api/me", { cookie: response.cookie })).body.user).toMatchObject({
      id: ana.userId,
      email: "ana@example.com",
      hasPassword: true,
    });
    expect(response.body).not.toHaveProperty("token");
    expect(response.body).not.toHaveProperty("sessionKey");
  });

  it("rejects wrong-password and nonexistent-user proofs without issuing cookies", async () => {
    for (const [email, password] of [
      ["ana@example.com", "wrong password"],
      ["missing@example.com", FIRST_PASSWORD],
    ]) {
      const response = await login(email, password);
      expect(response.accepted).toBe(false);
      expect(response.status).toBe(401);
      expect(cookieFrom(response.headers)).not.toContain("session_token");
      expect(response.body).toMatchObject({ code: "INVALID_EMAIL_OR_PASSWORD" });
    }
  });

  it("allows exactly one winner when identical finish requests race", async () => {
    const pending = await beginLogin("ana@example.com");
    expect(Object.keys(pending.started.body).toSorted()).toEqual(["challengeId", "loginResponse"]);
    const finishes = await Promise.all(
      [1, 2].map(() => request("/api/auth/opaque/login/finish", { json: pending.body })),
    );
    expect(finishes.map((r) => r.status).toSorted()).toEqual([200, 409]);
    expect(finishes.filter((r) => cookieFrom(r.headers).includes("session_token"))).toHaveLength(1);
    const replay = await request("/api/auth/opaque/login/finish", { json: pending.body });
    expect(replay.status).toBe(409);
  });

  it("rejects expired challenges and altered authenticated challenge metadata", async () => {
    const expired = await beginLogin("ana@example.com");
    await env.DB.prepare("UPDATE opaque_challenge SET expires_at = ? WHERE id = ?")
      .bind(Date.now() - 1, expired.body.challengeId)
      .run();
    expect((await request("/api/auth/opaque/login/finish", { json: expired.body })).status).toBe(
      409,
    );
    const altered = await beginLogin("ana@example.com");
    await env.DB.prepare("UPDATE opaque_challenge SET user_id = 'tampered' WHERE id = ?")
      .bind(altered.body.challengeId)
      .run();
    expect((await request("/api/auth/opaque/login/finish", { json: altered.body })).status).toBe(
      409,
    );
  });

  it("rejects a proof issued for password replacement at the login endpoint", async () => {
    const change = await beginPassword(ana, NEXT_PASSWORD, FIRST_PASSWORD);
    const response = await request("/api/auth/opaque/login/finish", {
      json: {
        challengeId: change.body.challengeId,
        finishLoginRequest: change.body.finishLoginRequest,
      },
    });
    expect(response.status).toBe(409);
    expect(cookieFrom(response.headers)).not.toContain("session_token");
  });

  it.each(["disabled", "unverified", "deleted"])(
    "rejects an in-flight proof after its user is %s",
    async (state) => {
      const pending = await beginLogin("ana@example.com");
      if (state === "disabled")
        await env.DB.prepare("UPDATE user SET banned = 1 WHERE id = ?").bind(ana.userId).run();
      if (state === "unverified")
        await env.DB.prepare("UPDATE user SET email_verified = 0 WHERE id = ?")
          .bind(ana.userId)
          .run();
      if (state === "deleted")
        await env.DB.prepare("DELETE FROM user WHERE id = ?").bind(ana.userId).run();
      const response = await request("/api/auth/opaque/login/finish", { json: pending.body });
      expect([401, 409]).toContain(response.status);
      expect(cookieFrom(response.headers)).not.toContain("session_token");
    },
  );

  it("rejects untrusted origins and malformed or oversized protocol messages", async () => {
    const context = await (await getAuth(env)).$context;
    // Better Auth disables origin checks under NODE_ENV=test by default. Exercise
    // the actual production policy, then restore the shared instance.
    const original = context.skipOriginCheck;
    context.skipOriginCheck = false;
    try {
      const pending = await beginLogin("ana@example.com");
      expect(
        (
          await request("/api/auth/opaque/login/finish", {
            origin: "https://evil.example",
            json: pending.body,
          })
        ).status,
      ).toBe(403);
      for (const startLoginRequest of ["%%%", "A".repeat(2049)]) {
        expect(
          (
            await request("/api/auth/opaque/login/start", {
              json: { email: "ana@example.com", startLoginRequest },
            })
          ).status,
        ).toBe(400);
      }
      expect((await request("/api/auth/opaque/login/finish", { json: pending.body })).status).toBe(
        200,
      );
    } finally {
      context.skipOriginCheck = original;
    }
  });
});
