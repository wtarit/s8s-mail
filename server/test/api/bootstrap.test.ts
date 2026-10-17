import { apiError } from "@s8s/shared";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { sendSystemMail } from "../../src/send";
import { BOOTSTRAP_TOKEN, acceptInvite, request, resetDb, type Json } from "../helpers";
import { REDIRECT, authorize } from "../helpers/auth-jmap";

vi.mock("../../src/send", () => ({ sendSystemMail: vi.fn(async () => {}) }));
const send = vi.mocked(sendSystemMail);

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

    // the invite lets the admin in; the account, address and domain exist
    const admin = await acceptInvite(first.body.invite.url);
    const me = await request<Json>("/api/me", { cookie: admin.cookie });
    expect(me.body.user).toMatchObject({ email: "admin@example.com", role: "admin" });
    expect(me.body.accounts).toHaveLength(1);
    expect(me.body.accounts[0]).toMatchObject({
      name: "Admin",
      addresses: [{ address: "admin@example.com", kind: "primary" }],
    });
    const domains = await request<Json>("/api/admin/domains", { cookie: admin.cookie });
    expect(domains.body.domains).toMatchObject([{ name: "example.com", addressCount: 1 }]);

    // the webmail OAuth client is registered, trusted and public, and the flow works with it
    const clients = await request<Json>("/api/admin/oauth-clients", { cookie: admin.cookie });
    expect(clients.body.clients).toMatchObject([
      {
        clientId: "bulwark-lite",
        trusted: true,
        public: true,
        redirectUris: ["http://localhost:4173/oauth/callback"],
      },
    ]);
    const { location } = await authorize(admin);
    expect(location.origin + location.pathname).toBe(REDIRECT);
    expect(location.searchParams.get("code")).toBeTruthy();

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
