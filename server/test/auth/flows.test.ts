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

describe("sign-up is disabled", () => {
  beforeEach(resetDb);

  it("rejects email sign-up and creates no user", async () => {
    const res = await request("/api/auth/sign-up/email", {
      method: "POST",
      json: { email: "new@example.com", password: "correct horse battery", name: "New" },
    });
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.status).toBeLessThan(500);
    const count = await env.DB.prepare("SELECT count(*) AS n FROM user").first<{ n: number }>();
    expect(count!.n).toBe(0);
  });

  it("does not create users through the magic-link endpoint either", async () => {
    send.mockClear();
    const res = await request("/api/auth/sign-in/magic-link", {
      method: "POST",
      json: { email: "stranger@example.com", callbackURL: "/" },
    });
    expect(res.status).toBe(200);
    const count = await env.DB.prepare("SELECT count(*) AS n FROM user").first<{ n: number }>();
    expect(count!.n).toBe(0);
  });
});

describe("password", () => {
  let ana: Session;
  beforeEach(async () => {
    await resetDb();
    const admin = await bootstrapAdmin();
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
    expect(wrongCurrent.status).toBeGreaterThanOrEqual(400);
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

    // the hash is Better Auth's scrypt format (salt:key), never PBKDF2
    const row = await env.DB.prepare(
      "SELECT password FROM account WHERE provider_id = 'credential'",
    ).first<{
      password: string;
    }>();
    expect(row!.password).toMatch(/^[0-9a-f]{32}:[0-9a-f]{128}$/);
  });

  it("a disabled user cannot sign in with a password", async () => {
    await request("/api/account/password", {
      method: "POST",
      cookie: ana.cookie,
      json: { newPassword: "first password 123" },
    });
    const admin = await bootstrapAdminAgain();
    await request(`/api/admin/users/${ana.userId}`, {
      method: "PATCH",
      cookie: admin.cookie,
      json: { disabled: true },
    });
    const res = await request("/api/auth/sign-in/email", {
      method: "POST",
      json: { email: "ana@example.com", password: "first password 123" },
    });
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect((await request("/api/me", { cookie: ana.cookie })).status).toBe(401);
  });
});

/** Signs in as the bootstrap admin again via magic-link-free path: new invite is not needed, use a session. */
async function bootstrapAdminAgain(): Promise<Session> {
  const admin = await env.DB.prepare("SELECT id FROM user WHERE role = 'admin'").first<{
    id: string;
  }>();
  // Admin has no password; mint a fresh session through a new invite from a direct DB insert.
  const token = "t".repeat(43);
  const hash = Array.from(
    new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token))),
    (b) => b.toString(16).padStart(2, "0"),
  ).join("");
  await env.DB.prepare(
    "INSERT INTO invite (id, token_hash, user_id, expires_at, created_at) VALUES (?, ?, ?, ?, ?)",
  )
    .bind(crypto.randomUUID(), hash, admin!.id, Date.now() + 60_000, Date.now())
    .run();
  return acceptInvite(`http://localhost:8787/invite/${token}`);
}

describe("magic link", () => {
  let ana: Session;
  beforeEach(async () => {
    await resetDb();
    const admin = await bootstrapAdmin();
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
    void ana;
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

  it("sends nothing for a user without a recovery address or a disabled user", async () => {
    await env.DB.prepare(
      "UPDATE user SET recovery_email = NULL WHERE email = 'ana@example.com'",
    ).run();
    await request("/api/auth/sign-in/magic-link", {
      method: "POST",
      json: { email: "ana@example.com", callbackURL: "/" },
    });
    await env.DB.prepare(
      "UPDATE user SET recovery_email = 'ana.recovery@example.org', banned = 1 WHERE email = 'ana@example.com'",
    ).run();
    await request("/api/auth/sign-in/magic-link", {
      method: "POST",
      json: { email: "ana@example.com", callbackURL: "/" },
    });
    await new Promise((r) => setTimeout(r, 200));
    expect(send).not.toHaveBeenCalled();
  });
});
