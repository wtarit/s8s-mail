import { beforeEach, describe, expect, it, vi } from "vitest";
import { request, resetDb, type Session, type Json } from "../helpers";
import { bootstrapAdmin } from "../helpers/accounts";

vi.mock("../../src/send", () => ({ sendSystemMail: vi.fn(async () => {}) }));

describe("admin: oauth clients", () => {
  let admin: Session;
  beforeEach(async () => {
    await resetDb();
    admin = await bootstrapAdmin();
  });

  it("oauth clients: ensure-defaults is idempotent, create/list/delete", async () => {
    const ensure = () =>
      request<Json>("/api/admin/oauth-clients/ensure-defaults", {
        method: "POST",
        cookie: admin.cookie,
        json: {},
      });
    const a = await ensure();
    const b = await ensure();
    expect(a.status).toBe(200);
    expect(b.body.client.clientId).toBe("bulwark-lite");

    const created = await request<Json>("/api/admin/oauth-clients", {
      method: "POST",
      cookie: admin.cookie,
      json: {
        name: "Wiki",
        redirectUris: ["https://wiki.example.com/cb"],
        trusted: false,
        public: false,
      },
    });
    expect(created.status).toBe(201);
    expect(created.body.clientSecret).toEqual(expect.any(String));
    expect(created.body.client).toMatchObject({ name: "Wiki", trusted: false, public: false });

    const pub = await request<Json>("/api/admin/oauth-clients", {
      method: "POST",
      cookie: admin.cookie,
      json: { name: "SPA", redirectUris: ["https://spa.example.com/cb"], trusted: true },
    });
    expect(pub.body.clientSecret).toBeNull();
    expect(pub.body.client).toMatchObject({ trusted: true, public: true });

    const list = await request<Json>("/api/admin/oauth-clients", { cookie: admin.cookie });
    expect(list.body.clients.map((c: Json) => c.name).toSorted()).toEqual([
      "SPA",
      "Webmail",
      "Wiki",
    ]);

    const del = await request(`/api/admin/oauth-clients/${created.body.client.clientId}`, {
      method: "DELETE",
      cookie: admin.cookie,
    });
    expect(del.status).toBe(200);
    expect(
      (await request<Json>("/api/admin/oauth-clients", { cookie: admin.cookie })).body.clients,
    ).toHaveLength(2);
  });
});
