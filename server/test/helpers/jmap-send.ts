/* oxlint-disable typescript/no-explicit-any -- JSON responses are read untyped in tests */
import { env } from "cloudflare:workers";
import { afterEach, beforeEach, vi } from "vitest";
import type { testApp } from "./jmap";

export const bytes = (s: string) => new TextEncoder().encode(s);

export async function upload(
  app: ReturnType<typeof testApp>,
  accountId: string,
  body: Uint8Array,
  type: string,
) {
  const res = await app.request(
    `/jmap/upload/${accountId}/`,
    { method: "POST", headers: { "content-type": type }, body },
    env,
  );
  return { res, json: (await res.clone().json()) as any };
}

export let fetchSpy: ReturnType<typeof vi.spyOn>;

/** Stubs global fetch with a Mailgun "Queued" reply (Mailgun is the configured provider). */
export function installMailgunFetchMock() {
  beforeEach(() => {
    (env as unknown as Record<string, string>).MAILGUN_API = "key-test";
    fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(
      async () =>
        new Response(JSON.stringify({ id: "<mg-1@example.com>", message: "Queued" }), {
          status: 200,
        }),
    );
  });
  afterEach(() => {
    fetchSpy.mockRestore();
  });
}
