import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { acceptInvite, bootstrapAdmin, request, type Session, type Json } from "../helpers";
import { callJmap, resetDb, basic, createAppPassword } from "../helpers/auth-jmap";

vi.mock("../../src/send", () => ({ sendSystemMail: vi.fn(async () => {}) }));

describe("jmapAuth: app passwords (Basic)", () => {
  let ana: Session;
  let accountIds: string[];
  beforeEach(async () => {
    await resetDb();
    const admin = await bootstrapAdmin();
    const created = await request<Json>("/api/admin/users", {
      method: "POST",
      cookie: admin.cookie,
      json: { name: "Ana", primaryAddress: "ana@example.com", recoveryEmail: "r@example.org" },
    });
    ana = await acceptInvite(created.body.invite.url);
    accountIds = (await request<Json>("/api/me", { cookie: ana.cookie })).body.accounts.map(
      (a: Json) => a.id,
    );
  });

  it("accepts a valid app password and exposes the principal", async () => {
    const key = await createAppPassword(ana);
    expect(key.startsWith("s8s_")).toBe(true);
    const res = await callJmap(basic("Ana@Example.com", key));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ userId: ana.userId, email: "ana@example.com", accountIds });
  });

  it("lists app passwords as {apiKeys} and records last use at most every 10 minutes", async () => {
    await createAppPassword(ana);
    const key = await createAppPassword(ana);
    const before = await request<Json>("/api/auth/api-key/list", { cookie: ana.cookie });
    expect(before.status).toBe(200);
    expect(before.body.apiKeys).toHaveLength(2);
    expect(before.body.apiKeys[0].lastRequest ?? null).toBeNull();
    expect((await callJmap(basic("ana@example.com", key))).status).toBe(200);
    await vi.waitFor(async () => {
      const row = await env.DB.prepare(
        "SELECT count(*) AS n FROM apikey WHERE last_request IS NOT NULL",
      ).first<{ n: number }>();
      expect(row!.n).toBe(1);
    });
    const list = await request<Json>("/api/auth/api-key/list", { cookie: ana.cookie });
    expect(list.body.apiKeys.filter((k: Json) => k.lastRequest)).toHaveLength(1);
  });

  it("stores only a fast hash of the key (not scrypt)", async () => {
    const key = await createAppPassword(ana);
    const row = await env.DB.prepare("SELECT key FROM apikey").first<{ key: string }>();
    expect(row!.key).not.toContain(key);
    expect(row!.key).toMatch(/^[A-Za-z0-9_-]{43}$/); // base64url(sha256)
  });

  it("rejects wrong password, wrong user, malformed and missing credentials with the challenge", async () => {
    const key = await createAppPassword(ana);
    const cases = [
      basic("ana@example.com", key + "x"),
      basic("admin@example.com", key), // someone else's name with Ana's key
      basic("ana@example.com", "ana password"),
      "Basic !!!not-base64",
      basic("ana@example.com", ""),
      "Basic",
      "Digest abc",
      undefined,
    ];
    for (const header of cases) {
      const res = await callJmap(header);
      expect(res.status, String(header)).toBe(401);
      expect(res.headers.get("www-authenticate")).toBe('Bearer, Basic realm="s8s-mail"');
    }
  });

  it("rejects disabled users, disabled keys and expired keys", async () => {
    const key = await createAppPassword(ana);
    await env.DB.prepare("UPDATE apikey SET expires_at = ?")
      .bind(Date.now() - 1000)
      .run();
    expect((await callJmap(basic("ana@example.com", key))).status).toBe(401);
    await env.DB.prepare("UPDATE apikey SET expires_at = NULL, enabled = 0").run();
    expect((await callJmap(basic("ana@example.com", key))).status).toBe(401);
    await env.DB.prepare("UPDATE apikey SET enabled = 1").run();
    expect((await callJmap(basic("ana@example.com", key))).status).toBe(200);
    await env.DB.prepare("UPDATE user SET banned = 1 WHERE email = 'ana@example.com'").run();
    expect((await callJmap(basic("ana@example.com", key))).status).toBe(401);
  });
});
