import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  acceptInvite,
  bootstrapAdmin,
  request,
  resetDb,
  type Session,
  type Json,
} from "../helpers";
import { createUser } from "../helpers/admin";

vi.mock("../../src/send", () => ({ sendSystemMail: vi.fn(async () => {}) }));

function patchDomain(cookie: string, name: string, json: unknown) {
  return request<Json>(`/api/admin/domains/${name}`, { method: "PATCH", cookie, json });
}

async function catchAllOf(name = "example.com") {
  const row = await env.DB.prepare("SELECT catch_all_address AS c FROM domain WHERE name = ?")
    .bind(name)
    .first<{ c: string | null }>();
  return row?.c;
}

describe("admin: aliases and domains", () => {
  let admin: Session;
  let userId: string;
  beforeEach(async () => {
    await resetDb();
    admin = await bootstrapAdmin();
    userId = (await createUser(admin)).body.user.id;
  });

  const addAlias = (address: string, id = userId) =>
    request<Json>(`/api/admin/users/${id}/aliases`, {
      method: "POST",
      cookie: admin.cookie,
      json: { address },
    });

  it("adds, lists and deletes aliases with the uniqueness rules", async () => {
    await request("/api/admin/domains", {
      method: "POST",
      cookie: admin.cookie,
      json: { name: "Example.NET" },
    });

    const added = await addAlias("Sales@Example.net");
    expect(added.status).toBe(201);
    expect(added.body.aliases.map((a: Json) => a.address)).toEqual(["sales@example.net"]);

    // globally unique, also against primaries and other users' aliases
    expect((await addAlias("sales@example.net")).status).toBe(409);
    expect((await addAlias("admin@example.com")).status).toBe(409);
    expect((await addAlias("ana@example.com")).status).toBe(409);
    const other = await createUser(admin, { name: "Bo", primaryAddress: "bo@example.com" });
    expect((await addAlias("sales@example.net", other.body.user.id)).status).toBe(409);
    // domain must be served, no plus-addressing, valid address
    expect((await addAlias("x@nope.example")).status).toBe(400);
    expect((await addAlias("x+y@example.com")).status).toBe(400);
    expect((await addAlias("nope")).status).toBe(400);
    expect((await addAlias("x@example.com", "missing-user")).status).toBe(404);

    const list = await request<Json>(`/api/admin/users/${userId}/aliases`, {
      cookie: admin.cookie,
    });
    expect(list.body.aliases).toHaveLength(1);
    const users = await request<Json>("/api/admin/users", { cookie: admin.cookie });
    expect(users.body.users.find((u: Json) => u.id === userId).aliasCount).toBe(1);

    // /api/me shows the alias after the primary
    const inv = await request<Json>(`/api/admin/users/${userId}/invite`, {
      method: "POST",
      cookie: admin.cookie,
      json: {},
    });
    const ana = await acceptInvite(inv.body.invite.url);
    const me = await request<Json>("/api/me", { cookie: ana.cookie });
    expect(me.body.accounts[0].addresses).toEqual([
      { address: "ana@example.com", kind: "primary" },
      { address: "sales@example.net", kind: "alias" },
    ]);

    // a primary address cannot be removed through the alias route
    const delPrimary = await request(`/api/admin/users/${userId}/aliases/ana%40example.com`, {
      method: "DELETE",
      cookie: admin.cookie,
    });
    expect(delPrimary.status).toBe(404);
    const del = await request<Json>(
      `/api/admin/users/${userId}/aliases/${encodeURIComponent("sales@example.net")}`,
      {
        method: "DELETE",
        cookie: admin.cookie,
      },
    );
    expect(del.status).toBe(200);
    expect(del.body.aliases).toEqual([]);
  });

  it("domains: add, duplicate, list counts, delete only when unused", async () => {
    const add = await request<Json>("/api/admin/domains", {
      method: "POST",
      cookie: admin.cookie,
      json: { name: "Extra.Example.ORG" },
    });
    expect(add.status).toBe(201);
    expect(add.body.domains.map((d: Json) => d.name)).toEqual(["example.com", "extra.example.org"]);
    expect(
      (
        await request("/api/admin/domains", {
          method: "POST",
          cookie: admin.cookie,
          json: { name: "extra.example.org" },
        })
      ).status,
    ).toBe(409);
    expect(
      (
        await request("/api/admin/domains", {
          method: "POST",
          cookie: admin.cookie,
          json: { name: "bad domain" },
        })
      ).status,
    ).toBe(400);

    const list = await request<Json>("/api/admin/domains", { cookie: admin.cookie });
    expect(list.body.domains.find((d: Json) => d.name === "example.com").addressCount).toBe(2);

    const inUse = await request<Json>("/api/admin/domains/example.com", {
      method: "DELETE",
      cookie: admin.cookie,
    });
    expect(inUse.status).toBe(409);
    expect(inUse.body.error.code).toBe("domain_in_use");
    const ok = await request<Json>("/api/admin/domains/extra.example.org", {
      method: "DELETE",
      cookie: admin.cookie,
    });
    expect(ok.status).toBe(200);
    expect(ok.body.domains.map((d: Json) => d.name)).toEqual(["example.com"]);
    expect(
      (
        await request("/api/admin/domains/extra.example.org", {
          method: "DELETE",
          cookie: admin.cookie,
        })
      ).status,
    ).toBe(404);
  });

  describe("domain catch-all", () => {
    it("is null by default, can be set to any existing address and cleared", async () => {
      const list = await request<Json>("/api/admin/domains", { cookie: admin.cookie });
      expect(list.body.domains[0].catchAllAddress).toBeNull();

      const set = await patchDomain(admin.cookie, "example.com", {
        catchAllAddress: "Admin@Example.com",
      });
      expect(set.status).toBe(200);
      expect(set.body.domains[0].catchAllAddress).toBe("admin@example.com");
      expect(await catchAllOf()).toBe("admin@example.com");

      // an alias on another served domain is fine too
      await request("/api/admin/domains", {
        method: "POST",
        cookie: admin.cookie,
        json: { name: "example.net" },
      });
      await addAlias("hello@example.net");
      const other = await patchDomain(admin.cookie, "example.com", {
        catchAllAddress: "hello@example.net",
      });
      expect(other.body.domains.find((d: Json) => d.name === "example.com").catchAllAddress).toBe(
        "hello@example.net",
      );

      const cleared = await patchDomain(admin.cookie, "example.com", { catchAllAddress: null });
      expect(cleared.status).toBe(200);
      expect(
        cleared.body.domains.find((d: Json) => d.name === "example.com").catchAllAddress,
      ).toBeNull();
      expect(await catchAllOf()).toBeNull();
    });

    it("validates: unknown domain 404, unknown address 400, bad body 400", async () => {
      expect(
        (await patchDomain(admin.cookie, "nope.example", { catchAllAddress: null })).status,
      ).toBe(404);
      const unknown = await patchDomain(admin.cookie, "example.com", {
        catchAllAddress: "ghost@example.com",
      });
      expect(unknown.status).toBe(400);
      expect(unknown.body.error.code).toBe("invalid_catch_all");
      expect(
        (await patchDomain(admin.cookie, "example.com", { catchAllAddress: "not-an-email" }))
          .status,
      ).toBe(400);
      expect((await patchDomain(admin.cookie, "example.com", {})).status).toBe(400);
      expect(await catchAllOf()).toBeNull();
    });

    it("lists every address with its kind and account name", async () => {
      await addAlias("sales@example.com");
      const res = await request<Json>("/api/admin/addresses", { cookie: admin.cookie });
      expect(res.status).toBe(200);
      expect(res.body.addresses).toEqual([
        { address: "admin@example.com", kind: "primary", accountName: expect.any(String) },
        { address: "ana@example.com", kind: "primary", accountName: "Ana" },
        { address: "sales@example.com", kind: "alias", accountName: "Ana" },
      ]);
    });

    it("is cleared when the alias it points at is deleted", async () => {
      await addAlias("sales@example.com");
      await patchDomain(admin.cookie, "example.com", { catchAllAddress: "sales@example.com" });
      // an unrelated catch-all on another domain is left alone
      await request("/api/admin/domains", {
        method: "POST",
        cookie: admin.cookie,
        json: { name: "example.net" },
      });
      await patchDomain(admin.cookie, "example.net", { catchAllAddress: "admin@example.com" });

      const del = await request(
        `/api/admin/users/${userId}/aliases/${encodeURIComponent("sales@example.com")}`,
        { method: "DELETE", cookie: admin.cookie },
      );
      expect(del.status).toBe(200);
      expect(await catchAllOf("example.com")).toBeNull();
      expect(await catchAllOf("example.net")).toBe("admin@example.com");
    });

    it("is cleared (on every domain) when the owning user is deleted", async () => {
      await addAlias("sales@example.com");
      await request("/api/admin/domains", {
        method: "POST",
        cookie: admin.cookie,
        json: { name: "example.net" },
      });
      await patchDomain(admin.cookie, "example.com", { catchAllAddress: "ana@example.com" });
      await patchDomain(admin.cookie, "example.net", { catchAllAddress: "sales@example.com" });

      const del = await request(`/api/admin/users/${userId}`, {
        method: "DELETE",
        cookie: admin.cookie,
      });
      expect(del.status).toBe(200);
      expect(await catchAllOf("example.com")).toBeNull();
      expect(await catchAllOf("example.net")).toBeNull();
    });
  });
});
