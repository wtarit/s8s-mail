import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { acceptInvite, bootstrapAdmin, request, type Session, type Json } from "../helpers";
import { callJmap, resetDb, basic, createAppPassword } from "../helpers/auth-jmap";

vi.mock("../../src/send", () => ({ sendSystemMail: vi.fn(async () => {}) }));

const useAt = async (key: string, at: number) => {
  const clock = vi.spyOn(Date, "now").mockReturnValue(at);
  try {
    expect((await callJmap(basic("ana@example.com", key))).status).toBe(200);
  } finally {
    clock.mockRestore();
  }
};
const settle = () => new Promise((r) => setTimeout(r, 200));

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

  const lastUsed = async () => {
    const list = await request<Json>("/api/auth/api-key/list", { cookie: ana.cookie });
    expect(list.status).toBe(200);
    const used = list.body.apiKeys.filter((k: Json) => k.lastRequest);
    return used.length ? new Date(used[0].lastRequest).getTime() : null;
  };

  it("lists app passwords as {apiKeys}, unused until a JMAP request authenticates with one", async () => {
    await createAppPassword(ana);
    const key = await createAppPassword(ana);
    const before = await request<Json>("/api/auth/api-key/list", { cookie: ana.cookie });
    expect(before.status).toBe(200);
    expect(before.body.apiKeys).toHaveLength(2);
    expect(before.body.apiKeys.every((k: Json) => !k.lastRequest)).toBe(true);
    expect((await callJmap(basic("ana@example.com", key))).status).toBe(200);
    await vi.waitFor(async () => expect(await lastUsed()).not.toBeNull());
    const list = await request<Json>("/api/auth/api-key/list", { cookie: ana.cookie });
    expect(list.body.apiKeys.filter((k: Json) => k.lastRequest)).toHaveLength(1);
  });

  it("records last use at most every 10 minutes", async () => {
    const key = await createAppPassword(ana);
    const t0 = Date.now();
    await useAt(key, t0);
    await vi.waitFor(async () => expect(await lastUsed()).toBe(t0));

    // Within 10 minutes: authenticates, but the recorded time does not move.
    await useAt(key, t0 + 5 * 60_000);
    await settle();
    expect(await lastUsed()).toBe(t0);

    // After 10 minutes: recorded again.
    await useAt(key, t0 + 11 * 60_000);
    await vi.waitFor(async () => expect(await lastUsed()).toBe(t0 + 11 * 60_000));
  });

  it("does not store the app password in clear", async () => {
    const key = await createAppPassword(ana);
    const row = await env.DB.prepare("SELECT key FROM apikey").first<{ key: string }>();
    expect(row!.key).not.toContain(key);
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
