import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { sendSystemMail } from "../../src/send";
import {
  acceptInvite,
  bootstrapAdmin,
  cookieFrom,
  request,
  resetDb,
  type Session,
  type Json,
} from "../helpers";

vi.mock("../../src/send", () => ({ sendSystemMail: vi.fn(async () => {}) }));
const send = vi.mocked(sendSystemMail);

async function newUser(admin: Session, address = "ana@example.com") {
  const res = await request<{ user: { id: string }; invite: { url: string } }>("/api/admin/users", {
    method: "POST",
    cookie: admin.cookie,
    json: { name: "Ana", primaryAddress: address, recoveryEmail: "ana.recovery@example.org" },
  });
  expect(res.status).toBe(201);
  return res.body;
}

const emailsOf = async (admin: Session) =>
  (
    await request<{ users: { email: string }[] }>("/api/admin/users", { cookie: admin.cookie })
  ).body.users
    .map((u) => u.email)
    .toSorted();

describe("sign-up is disabled", () => {
  let admin: Session;
  beforeEach(async () => {
    await resetDb();
    admin = await bootstrapAdmin();
    send.mockClear();
  });

  it("rejects email sign-up and creates no user", async () => {
    const credentials = { email: "new@example.com", password: "correct horse battery" };
    const res = await request("/api/auth/sign-up/email", {
      method: "POST",
      json: { ...credentials, name: "New" },
    });
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ code: "EMAIL_PASSWORD_SIGN_UP_DISABLED" });
    expect(await emailsOf(admin)).toEqual(["admin@example.com"]);
    const signIn = await request("/api/auth/sign-in/email", { method: "POST", json: credentials });
    expect(signIn.status).toBe(401);
  });

  it("does not create users through the magic-link endpoint either", async () => {
    const res = await request("/api/auth/sign-in/magic-link", {
      method: "POST",
      json: { email: "stranger@example.com", callbackURL: "/" },
    });
    expect(res.status).toBe(200);
    expect(await emailsOf(admin)).toEqual(["admin@example.com"]);
  });
});

describe("password", () => {
  let admin: Session;
  let ana: Session;
  beforeEach(async () => {
    await resetDb();
    admin = await bootstrapAdmin();
    const created = await newUser(admin);
    ana = await acceptInvite(created.invite.url);
  });

  it("is set once, then needs the current password to change; email+password sign-in works", async () => {
    // no password yet
    expect((await request<Json>("/api/me", { cookie: ana.cookie })).body.user.hasPassword).toBe(
      false,
    );
    // too short
    const short = await request("/api/account/password", {
      method: "POST",
      cookie: ana.cookie,
      json: { newPassword: "short" },
    });
    expect(short.status).toBe(400);

    const set = await request("/api/account/password", {
      method: "POST",
      cookie: ana.cookie,
      json: { newPassword: "first password 123" },
    });
    expect(set.status).toBe(200);
    expect((await request<Json>("/api/me", { cookie: ana.cookie })).body.user.hasPassword).toBe(
      true,
    );

    // changing requires the current password
    const noCurrent = await request("/api/account/password", {
      method: "POST",
      cookie: ana.cookie,
      json: { newPassword: "second password 456" },
    });
    expect(noCurrent.status).toBe(400);
    const wrongCurrent = await request("/api/account/password", {
      method: "POST",
      cookie: ana.cookie,
      json: { currentPassword: "not my password", newPassword: "second password 456" },
    });
    expect(wrongCurrent.status).toBe(400);
    expect((wrongCurrent.body as Json).error.code).toBe("invalid_password");
    const changed = await request("/api/account/password", {
      method: "POST",
      cookie: ana.cookie,
      json: { currentPassword: "first password 123", newPassword: "second password 456" },
    });
    expect(changed.status).toBe(200);

    const bad = await request("/api/auth/sign-in/email", {
      method: "POST",
      json: { email: "ana@example.com", password: "first password 123" },
    });
    expect(bad.status).toBe(401);
    const good = await request<Json>("/api/auth/sign-in/email", {
      method: "POST",
      json: { email: "Ana@Example.com", password: "second password 456" },
    });
    expect(good.status).toBe(200);
    const cookie = cookieFrom(good.headers);
    expect((await request<Json>("/api/me", { cookie })).body.user.email).toBe("ana@example.com");
  });

  it("a disabled user cannot sign in with a password", async () => {
    await request("/api/account/password", {
      method: "POST",
      cookie: ana.cookie,
      json: { newPassword: "first password 123" },
    });
    await request(`/api/admin/users/${ana.userId}`, {
      method: "PATCH",
      cookie: admin.cookie,
      json: { disabled: true },
    });
    const res = await request("/api/auth/sign-in/email", {
      method: "POST",
      json: { email: "ana@example.com", password: "first password 123" },
    });
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ code: "BANNED_USER" });
    expect((await request("/api/me", { cookie: ana.cookie })).status).toBe(401);
  });
});

const requestMagicLink = () =>
  request("/api/auth/sign-in/magic-link", {
    method: "POST",
    json: { email: "ana@example.com", callbackURL: "/" },
  });

describe("magic link", () => {
  let admin: Session;
  let ana: Session;
  beforeEach(async () => {
    await resetDb();
    admin = await bootstrapAdmin();
    ana = await acceptInvite((await newUser(admin)).invite.url);
    send.mockClear();
  });

  it("is sent only to the recovery address and signs the user in", async () => {
    const res = await request<Json>("/api/auth/sign-in/magic-link", {
      method: "POST",
      json: { email: "ANA@example.com", callbackURL: "/" },
    });
    expect(res.status).toBe(200);
    await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(1));
    const mail = send.mock.calls[0]![1];
    expect(mail.to).toBe("ana.recovery@example.org");
    expect(mail.subject).toContain("S8S Mail");
    const url = /https?:\/\/\S+magic-link\/verify\S+/.exec(mail.text)![0];
    expect(url.startsWith("http://localhost:8787/api/auth/magic-link/verify?token=")).toBe(true);

    const verify = await request(url.replace("http://localhost:8787", ""), { method: "GET" });
    expect(verify.status).toBe(302);
    const cookie = cookieFrom(verify.headers);
    expect(cookie).toContain("better-auth.session_token");
    expect((await request<Json>("/api/me", { cookie })).body.user.email).toBe("ana@example.com");

    // single use
    const replay = await request(url.replace("http://localhost:8787", ""), { method: "GET" });
    expect(cookieFrom(replay.headers)).not.toContain("session_token");
  });

  it("accepts absolute SPA-origin callback URLs and answers {status:true}", async () => {
    const res = await request<Json>("/api/auth/sign-in/magic-link", {
      method: "POST",
      json: {
        email: "ana@example.com",
        callbackURL: "http://localhost:8787/",
        errorCallbackURL: "http://localhost:8787/login",
      },
    });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: true });
    await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(1));
    const bad = await request<Json>("/api/auth/sign-in/magic-link", {
      method: "POST",
      json: { email: "ana@example.com", callbackURL: "https://evil.example/" },
    });
    expect(bad.status).toBe(403);
  });

  it("sends nothing and answers identically for unknown emails", async () => {
    const known = await request<Json>("/api/auth/sign-in/magic-link", {
      method: "POST",
      json: { email: "ana@example.com", callbackURL: "/" },
    });
    await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(1));
    send.mockClear();
    const unknown = await request<Json>("/api/auth/sign-in/magic-link", {
      method: "POST",
      json: { email: "nobody@example.com", callbackURL: "/" },
    });
    expect(unknown.status).toBe(known.status);
    expect(unknown.body).toEqual(known.body);
    await new Promise((r) => setTimeout(r, 200));
    expect(send).not.toHaveBeenCalled();
  });

  it("sends nothing for a user without a recovery address", async () => {
    // No API clears a recovery address (create/patch require one), so set the state directly.
    await env.DB.prepare(
      "UPDATE user SET recovery_email = NULL WHERE email = 'ana@example.com'",
    ).run();
    await requestMagicLink();
    await new Promise((r) => setTimeout(r, 200));
    expect(send).not.toHaveBeenCalled();
  });

  it("sends nothing for a disabled user", async () => {
    const disabled = await request(`/api/admin/users/${ana.userId}`, {
      method: "PATCH",
      cookie: admin.cookie,
      json: { disabled: true },
    });
    expect(disabled.status).toBe(200);
    await requestMagicLink();
    await new Promise((r) => setTimeout(r, 200));
    expect(send).not.toHaveBeenCalled();
  });
});
