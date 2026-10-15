import { env } from "cloudflare:workers";
import { apiError } from "@s8s/shared";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { sendSystemMail } from "../../src/send";
import { BOOTSTRAP_TOKEN, request, resetDb, type Json } from "../helpers";

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
