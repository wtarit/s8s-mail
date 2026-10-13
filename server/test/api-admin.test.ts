import { env } from "cloudflare:workers";
import { adminUser, apiError, inviteInfoResponse, meResponse } from "@s8s/shared";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { sendSystemMail } from "../src/send";
import {
  acceptInvite,
  BOOTSTRAP_TOKEN,
  bootstrapAdmin,
  request,
  resetDb,
  tokenFromInviteUrl,
  type Session,
  type Json,
} from "./helpers";

vi.mock("../src/send", () => ({ sendSystemMail: vi.fn(async () => {}) }));
const send = vi.mocked(sendSystemMail);

async function createUser(admin: Session, over: Record<string, unknown> = {}) {
  return request<{ user: Json; invite: { url: string; expiresAt: string } }>("/api/admin/users", {
    method: "POST",
    cookie: admin.cookie,
    json: {
      name: "Ana",
      primaryAddress: "Ana@Example.com",
      recoveryEmail: "ana.recovery@example.org",
      ...over,
    },
  });
}

describe("bootstrap", () => {
  beforeEach(async () => {
    await resetDb();
    send.mockClear();
  });

  it("rejects a missing or wrong token", async () => {
    const body = {
      name: "Admin",
      primaryAddress: "admin@example.com",
      recoveryEmail: "r@example.org",
    };
    const none = await request("/api/bootstrap", { method: "POST", json: body });
    expect(none.status).toBe(401);
    const wrong = await request("/api/bootstrap", {
      method: "POST",
      json: body,
      headers: { authorization: "Bearer nope" },
    });
    expect(wrong.status).toBe(401);
    expect(apiError.safeParse(wrong.body).success).toBe(true);
  });

  it("creates the first admin once, then refuses", async () => {
    const body = {
      name: "Admin",
      primaryAddress: "Admin@Example.com",
      recoveryEmail: "r@example.org",
    };
    const headers = { authorization: `Bearer ${BOOTSTRAP_TOKEN}` };
    const first = await request<{ invite: { url: string; expiresAt: string } }>("/api/bootstrap", {
      method: "POST",
      json: body,
      headers,
    });
    expect(first.status).toBe(201);
    expect(first.body.invite.url).toMatch(/^http:\/\/localhost:8787\/invite\/[\w-]{40,}$/);

    // domain, mail account, primary address and the webmail OAuth client exist
    expect((await env.DB.prepare("SELECT name FROM domain").all()).results).toEqual([
      { name: "example.com" },
    ]);
    expect((await env.DB.prepare("SELECT address, kind FROM address").all()).results).toEqual([
      { address: "admin@example.com", kind: "primary" },
    ]);
    const client = await env.DB.prepare(
      "SELECT client_id, skip_consent, client_secret, redirect_uris FROM oauth_client",
    ).first<Record<string, unknown>>();
    expect(client).toMatchObject({
      client_id: "bulwark-lite",
      skip_consent: 1,
      client_secret: null,
    });
    expect(JSON.parse(JSON.parse(client!.redirect_uris as string))).toEqual([
      "http://localhost:4173/oauth/callback",
    ]);
    // the invite went to the recovery address
    await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(1));
    expect(send.mock.calls[0]![1].to).toBe("r@example.org");
    expect(send.mock.calls[0]![1].text).toContain(first.body.invite.url);

    const second = await request("/api/bootstrap", {
      method: "POST",
      json: { ...body, primaryAddress: "other@example.com" },
      headers,
    });
    expect(second.status).toBe(409);
    expect((second.body as Json).error.code).toBe("already_bootstrapped");
  });
});

describe("admin: users and invites", () => {
  let admin: Session;
  beforeEach(async () => {
    await resetDb();
    send.mockClear();
    admin = await bootstrapAdmin();
  });

  it("create user -> invite info -> accept -> session cookie works on /api/me", async () => {
    const created = await createUser(admin);
    expect(created.status).toBe(201);
    expect(adminUser.safeParse(created.body.user).success).toBe(true);
    expect(created.body.user).toMatchObject({
      name: "Ana",
      email: "ana@example.com",
      role: "user",
      status: "invited",
      aliasCount: 0,
      recoveryEmail: "ana.recovery@example.org",
      lastSignInAt: null,
    });
    const token = tokenFromInviteUrl(created.body.invite.url);

    // invite mail went to the recovery address
    await vi.waitFor(() =>
      expect(send.mock.calls.some(([, m]) => m.to === "ana.recovery@example.org")).toBe(true),
    );

    const info = await request(`/api/invite/${token}`);
    expect(inviteInfoResponse.parse(info.body)).toMatchObject({
      status: "valid",
      name: "Ana",
      email: "ana@example.com",
    });

    // /api/me without a session is 401
    expect((await request("/api/me")).status).toBe(401);

    const session = await acceptInvite(created.body.invite.url);
    expect(session.cookie).toContain("better-auth.session_token");
    const me = await request("/api/me", { cookie: session.cookie });
    expect(me.status).toBe(200);
    const parsed = meResponse.parse(me.body);
    expect(parsed.user).toMatchObject({
      email: "ana@example.com",
      role: "user",
      hasPassword: false,
      recoveryEmailMasked: "a•••@example.org",
    });
    expect(parsed.accounts).toHaveLength(1);
    expect(parsed.accounts[0]).toMatchObject({
      name: "Ana",
      isPersonal: true,
      addresses: [{ address: "ana@example.com", kind: "primary" }],
    });
    expect(parsed.accounts[0]!.id).toMatch(/^a[0-9a-f]{20}$/);

    // one-time: second accept and info both say used
    const again = await request(`/api/invite/${token}/accept`, { method: "POST", json: {} });
    expect(again.status).toBe(409);
    expect((again.body as Json).error.code).toBe("invite_used");
    expect((await request<Json>(`/api/invite/${token}`)).body.status).toBe("used");

    // list shows the user as active with a last sign-in
    const list = await request<{ users: Json[] }>("/api/admin/users", { cookie: admin.cookie });
    const ana = list.body.users.find((u) => u.email === "ana@example.com");
    expect(ana.status).toBe("active");
    expect(ana.lastSignInAt).not.toBeNull();
  });

  it("an expired invite cannot be accepted", async () => {
    const created = await createUser(admin);
    await env.DB.prepare("UPDATE invite SET expires_at = ?")
      .bind(Date.now() - 1000)
      .run();
    const token = tokenFromInviteUrl(created.body.invite.url);
    expect((await request<Json>(`/api/invite/${token}`)).body.status).toBe("expired");
    const res = await request(`/api/invite/${token}/accept`, { method: "POST", json: {} });
    expect(res.status).toBe(410);
    expect((res.body as Json).error.code).toBe("invite_expired");
    expect((await request("/api/invite/unknown-token")).status).toBe(404);
  });

  it("a new invite revokes the old one", async () => {
    const created = await createUser(admin);
    const res = await request<{ invite: { url: string } }>(
      `/api/admin/users/${created.body.user.id}/invite`,
      { method: "POST", cookie: admin.cookie, json: {} },
    );
    expect(res.status).toBe(200);
    expect(
      (await request(`/api/invite/${tokenFromInviteUrl(created.body.invite.url)}`)).status,
    ).toBe(404);
    expect((await request(`/api/invite/${tokenFromInviteUrl(res.body.invite.url)}`)).status).toBe(
      200,
    );
  });

  it("validates create-user input and uniqueness", async () => {
    expect((await createUser(admin, { primaryAddress: "x@unknown.example" })).status).toBe(400);
    expect((await createUser(admin, { primaryAddress: "a+tag@example.com" })).status).toBe(400);
    expect((await createUser(admin, { primaryAddress: "not-an-email" })).status).toBe(400);
    expect((await createUser(admin)).status).toBe(201);
    const dup = await createUser(admin, { name: "Other" });
    expect(dup.status).toBe(409);
    expect((dup.body as Json).error.code).toBe("address_taken");
    // the admin's own address is taken too
    expect((await createUser(admin, { primaryAddress: "admin@example.com" })).status).toBe(409);
  });

  it("non-admins get 403 on admin routes, anonymous gets 401", async () => {
    const created = await createUser(admin);
    const ana = await acceptInvite(created.body.invite.url);
    for (const [method, path] of [
      ["GET", "/api/admin/users"],
      ["POST", "/api/admin/users"],
      ["GET", "/api/admin/domains"],
      ["POST", "/api/admin/domains"],
      ["GET", "/api/admin/oauth-clients"],
      ["POST", "/api/admin/oauth-clients/ensure-defaults"],
      ["DELETE", `/api/admin/users/${created.body.user.id}`],
    ] as const) {
      const res = await request(path, {
        method,
        cookie: ana.cookie,
        json: method === "GET" || method === "DELETE" ? undefined : {},
      });
      expect(res.status, `${method} ${path}`).toBe(403);
      expect(apiError.safeParse(res.body).success).toBe(true);
      const anon = await request(path, {
        method,
        json: method === "GET" || method === "DELETE" ? undefined : {},
      });
      expect(anon.status, `anon ${method} ${path}`).toBe(401);
    }
  });

  it("rejects cross-origin mutations", async () => {
    const res = await request("/api/admin/domains", {
      method: "POST",
      cookie: admin.cookie,
      json: { name: "evil.example" },
      origin: "https://evil.example",
    });
    expect(res.status).toBe(403);
    expect((res.body as Json).error.code).toBe("bad_origin");
  });

  it("patches, disables (revoking sessions), re-enables and deletes a user", async () => {
    const created = await createUser(admin);
    const id = created.body.user.id as string;
    const ana = await acceptInvite(created.body.invite.url);

    const patched = await request<{ user: Json }>(`/api/admin/users/${id}`, {
      method: "PATCH",
      cookie: admin.cookie,
      json: { name: "Ana B", role: "admin", recoveryEmail: "New@Example.org" },
    });
    expect(patched.status).toBe(200);
    expect(patched.body.user).toMatchObject({
      name: "Ana B",
      role: "admin",
      recoveryEmail: "new@example.org",
    });
    expect(
      (await env.DB.prepare("SELECT name FROM mail_account WHERE owner_user_id = ?")
        .bind(id)
        .first())!.name,
    ).toBe("Ana B");

    const disabled = await request<{ user: Json }>(`/api/admin/users/${id}`, {
      method: "PATCH",
      cookie: admin.cookie,
      json: { disabled: true },
    });
    expect(disabled.body.user.status).toBe("disabled");
    expect((await request("/api/me", { cookie: ana.cookie })).status).toBe(401);
    // cannot accept a fresh invite while disabled
    const inv = await request<{ invite: { url: string } }>(`/api/admin/users/${id}/invite`, {
      method: "POST",
      cookie: admin.cookie,
      json: {},
    });
    expect(
      (
        await request(`/api/invite/${tokenFromInviteUrl(inv.body.invite.url)}/accept`, {
          method: "POST",
          json: {},
        })
      ).status,
    ).toBe(403);

    const enabled = await request<{ user: Json }>(`/api/admin/users/${id}`, {
      method: "PATCH",
      cookie: admin.cookie,
      json: { disabled: false },
    });
    expect(enabled.body.user.status).toBe("invited");

    // admins cannot disable/demote/delete themselves
    for (const json of [{ disabled: true }, { role: "user" }]) {
      expect(
        (
          await request(`/api/admin/users/${admin.userId}`, {
            method: "PATCH",
            cookie: admin.cookie,
            json,
          })
        ).status,
      ).toBe(400);
    }
    expect(
      (
        await request(`/api/admin/users/${admin.userId}`, {
          method: "DELETE",
          cookie: admin.cookie,
        })
      ).status,
    ).toBe(400);

    const del = await request(`/api/admin/users/${id}`, { method: "DELETE", cookie: admin.cookie });
    expect(del.status).toBe(200);
    expect(
      (await request(`/api/admin/users/${id}`, { method: "DELETE", cookie: admin.cookie })).status,
    ).toBe(404);
    const left = await env.DB.prepare(
      "SELECT (SELECT count(*) FROM user WHERE id = ?1) AS u, (SELECT count(*) FROM mail_account WHERE owner_user_id = ?1) AS a, (SELECT count(*) FROM address WHERE address = 'ana@example.com') AS ad",
    )
      .bind(id)
      .first();
    expect(left).toEqual({ u: 0, a: 0, ad: 0 });
  });
});

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
