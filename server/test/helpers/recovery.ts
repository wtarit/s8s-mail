import { expect, vi } from "vitest";
import { sendSystemMail } from "../../src/send";
import { request } from "./index";

/** Requests a magic link and returns the verify path from the (mocked) recovery email. */
export async function requestMagicLink(email: string, callbackURL = "http://localhost:8787/after") {
  const send = vi.mocked(sendSystemMail);
  send.mockClear();
  const res = await request("/api/auth/sign-in/magic-link", {
    method: "POST",
    json: { email, callbackURL },
  });
  expect(res.status).toBe(200);
  await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(1));
  const url = /https?:\/\/\S+magic-link\/verify\S+/.exec(send.mock.calls[0]![1].text)![0];
  return url.replace("http://localhost:8787", "");
}

/** Opens the recovery link; returns the verify reply (a redirect). */
export async function openMagicLink(email: string, callbackURL?: string) {
  return request(await requestMagicLink(email, callbackURL), { method: "GET" });
}
