import { beforeEach, describe, expect, it, vi } from "vitest";
import { createAuthClient } from "better-auth/react";
import { oauthProviderClient } from "@better-auth/oauth-provider/client";
import { opaqueClient } from "./client";
import { OpaqueError } from "./worker-client";
import type * as WorkerClient from "./worker-client";

const crypto = vi.hoisted(() => ({ run: vi.fn(), close: vi.fn() }));
vi.mock("./worker-client", async (importOriginal) => ({
  ...(await importOriginal<typeof WorkerClient>()),
  createCryptoWorker: () => crypto,
}));

const notify = vi.fn();
function createAppAuthClient(baseURL: string) {
  return createAuthClient({
    baseURL,
    fetchOptions: { credentials: "include" },
    plugins: [
      opaqueClient(),
      oauthProviderClient(),
      {
        id: "test-notifications",
        getActions: (_fetch, store) => {
          vi.spyOn(store, "notify").mockImplementation(notify);
          return {};
        },
      },
    ],
  });
}

const calls: Array<{
  path: string;
  body: Record<string, unknown> | undefined;
  credentials?: RequestCredentials;
}> = [];
function transport(response: unknown = { user: { id: "u1" }, redirect: false }) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string, init: RequestInit) => {
      const path = new URL(input).pathname;
      const body = init.body ? JSON.parse(String(init.body)) : undefined;
      calls.push({ path, body, credentials: init.credentials });
      if (path.endsWith("/start"))
        return Response.json({
          challengeId: "challenge",
          loginResponse: "response",
          registrationResponse: "registration",
        });
      return Response.json(response);
    }),
  );
}

beforeEach(() => {
  calls.length = 0;
  notify.mockClear();
  crypto.run.mockReset();
  crypto.close.mockReset();
  window.history.replaceState({}, "", "/login");
  transport();
});

describe("OPAQUE Better Auth client transport", () => {
  it("sends protocol messages only, retains credentials and refreshes the session", async () => {
    crypto.run
      .mockResolvedValueOnce({ startLoginRequest: "request" })
      .mockResolvedValueOnce({ finishLoginRequest: "proof" });
    const client = createAppAuthClient("https://api.example.com");
    const result = await client.signIn.opaque({
      email: "ada@example.com",
      password: "never-send-this-password",
    });
    expect(result.error).toBeNull();
    expect(calls.map((call) => call.path)).toEqual([
      "/api/auth/opaque/login/start",
      "/api/auth/opaque/login/finish",
    ]);
    expect(calls[0]?.body).toEqual({ email: "ada@example.com", startLoginRequest: "request" });
    expect(calls[1]?.body).toEqual({ challengeId: "challenge", finishLoginRequest: "proof" });
    expect(JSON.stringify(calls)).not.toContain("never-send-this-password");
    expect(calls.every((call) => call.credentials === "include")).toBe(true);
    expect(crypto.run).toHaveBeenLastCalledWith({ type: "finish", loginResponse: "response" });
    expect(notify).toHaveBeenCalledWith("$sessionSignal");
    expect(crypto.close).toHaveBeenCalledOnce();
  });
  it("preserves signed OAuth queries and returns the Better Auth redirect", async () => {
    window.history.replaceState({}, "", "/login?client_id=webmail&sig=abc&ba_param=client_id");
    const redirect = { redirect: true, url: "https://webmail.example.com/cb?code=1" };
    transport(redirect);
    crypto.run
      .mockResolvedValueOnce({ startLoginRequest: "request" })
      .mockResolvedValueOnce({ finishLoginRequest: "proof" });
    const client = createAppAuthClient("https://api.example.com");
    const result = await client.signIn.opaque({ email: "ada@example.com", password: "secret" });
    expect(calls[1]?.body?.oauth_query).toContain("sig=abc");
    expect(result.data).toEqual(redirect);
    expect(crypto.close).toHaveBeenCalledOnce();
  });
  it("enrolls/changes passwords using records and proofs without plaintext HTTP", async () => {
    crypto.run
      .mockResolvedValueOnce({ registrationRequest: "request", startLoginRequest: "old-request" })
      .mockResolvedValueOnce({ registrationRecord: "record", finishLoginRequest: "old-proof" });
    transport({ ok: true });
    const result = await createAppAuthClient("https://api.example.com").opaque.setPassword({
      newPassword: "new-secret",
      currentPassword: "old-secret",
    });
    expect(result.error).toBeNull();
    expect(calls[0]?.body).toEqual({
      registrationRequest: "request",
      startLoginRequest: "old-request",
    });
    expect(calls[1]?.body).toEqual({
      challengeId: "challenge",
      registrationRecord: "record",
      finishLoginRequest: "old-proof",
    });
    expect(JSON.stringify(calls)).not.toMatch(/new-secret|old-secret/);
    expect(crypto.close).toHaveBeenCalledOnce();
  });
  it("does not refresh the session when the password step still needs a passkey", async () => {
    transport({ passkeyRequired: true, redirect: false });
    crypto.run
      .mockResolvedValueOnce({ startLoginRequest: "request" })
      .mockResolvedValueOnce({ finishLoginRequest: "proof" });
    const client = createAppAuthClient("https://api.example.com");
    const result = await client.signIn.opaque({ email: "ada@example.com", password: "secret" });
    expect(result.error).toBeNull();
    expect(result.data).toEqual({ passkeyRequired: true, redirect: false });
    expect(notify).not.toHaveBeenCalled();
    expect(crypto.close).toHaveBeenCalledOnce();
  });
  it("steps up the current session through the step-up endpoints", async () => {
    transport({ ok: true });
    crypto.run
      .mockResolvedValueOnce({ startLoginRequest: "request" })
      .mockResolvedValueOnce({ finishLoginRequest: "proof" });
    const result = await createAppAuthClient("https://api.example.com").opaque.stepUp({
      password: "never-send-this-password",
    });
    expect(result.error).toBeNull();
    expect(calls.map((call) => call.path)).toEqual([
      "/api/auth/step-up/password/start",
      "/api/auth/step-up/password/finish",
    ]);
    expect(calls[0]?.body).toEqual({ startLoginRequest: "request" });
    expect(calls[1]?.body).toEqual({ challengeId: "challenge", finishLoginRequest: "proof" });
    expect(JSON.stringify(calls)).not.toContain("never-send-this-password");
    expect(calls.every((call) => call.credentials === "include")).toBe(true);
    expect(notify).toHaveBeenCalledWith("$sessionSignal");
    expect(crypto.close).toHaveBeenCalledOnce();
  });
  it("reports a wrong password without sending a completion and destroys the worker", async () => {
    crypto.run
      .mockResolvedValueOnce({ startLoginRequest: "request" })
      .mockRejectedValueOnce(new OpaqueError("INVALID_EMAIL_OR_PASSWORD"));
    const client = createAppAuthClient("https://api.example.com");
    const result = await client.opaque.stepUp({ password: "wrong" });
    expect(result.error?.code).toBe("INVALID_EMAIL_OR_PASSWORD");
    expect(calls).toHaveLength(1);
    expect(notify).not.toHaveBeenCalled();
    expect(crypto.close).toHaveBeenCalledOnce();
  });
});
