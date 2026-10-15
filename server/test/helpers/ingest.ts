/* oxlint-disable typescript/no-explicit-any -- JSON responses are read untyped in tests */
import { env } from "cloudflare:workers";
import { runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { expect, vi } from "vitest";
import { handleEmail } from "../../src/mail/ingest";
import { accountStub } from "../../src/store/subscribe";
import { call, resp, type TestApp } from "./jmap";
import { ctx, fakeMessage } from "./mail";

/** Delivers a raw message through the real email() handler (no parse alarm is run). */
export async function deliver(to: string, raw: string) {
  const { message, setReject } = fakeMessage(to, raw);
  await handleEmail(message, env, ctx);
  return { setReject };
}

export async function r2Keys(accountId: string): Promise<string[]> {
  return (await env.BLOBS.list({ prefix: `${accountId}/` })).objects.map((o) => o.key);
}

export async function setCatchAll(domainName: string, address: string | null) {
  await env.DB.prepare("UPDATE domain SET catch_all_address = ? WHERE name = ?")
    .bind(address, domainName)
    .run();
}

/**
 * Sync condition only: runs the parse alarm until no message is waiting for its body parse
 * (parsed or failed). The alarm may also fire on its own in the test runtime.
 */
export async function settleParse(accountId: string): Promise<void> {
  const stub = accountStub(env, accountId);
  await vi.waitFor(async () => {
    await runDurableObjectAlarm(stub);
    const pending = await runInDurableObject(
      stub,
      (_i, state) =>
        state.storage.sql
          .exec<{ n: number }>("SELECT count(*) AS n FROM email WHERE parse_state = 'pending'")
          .one().n,
    );
    expect(pending).toBe(0);
  });
}

/** Email/query (oldest first) + Email/get of the given properties. */
export async function getEmails(
  app: TestApp,
  accountId: string,
  properties: string[],
  extra: Record<string, unknown> = {},
  filter?: Record<string, unknown>,
): Promise<Record<string, any>[]> {
  const r = await call(app, [
    [
      "Email/query",
      { accountId, filter, sort: [{ property: "receivedAt", isAscending: true }] },
      "q",
    ],
    [
      "Email/get",
      {
        accountId,
        "#ids": { resultOf: "q", name: "Email/query", path: "/ids" },
        properties,
        ...extra,
      },
      "g",
    ],
  ]);
  return resp(r, 1).args.list;
}

/** Ids matching an Email/query filter. */
export async function searchIds(
  app: TestApp,
  accountId: string,
  filter: Record<string, unknown> = {},
): Promise<string[]> {
  return resp(await call(app, [["Email/query", { accountId, filter }, "q"]])).args.ids;
}

/** JMAP state strings are opaque: callers only compare them for (in)equality. */
export async function stateOf(
  app: TestApp,
  accountId: string,
  type: "Email" | "Thread" | "Mailbox",
): Promise<string> {
  const r = await call(app, [[`${type}/get`, { accountId, ids: [] }, "s"]]);
  return resp(r).args.state;
}

/** Downloads a blob through the JMAP download endpoint. */
export async function download(
  app: TestApp,
  accountId: string,
  blobId: string,
  name = "blob",
): Promise<Response> {
  return app.request(`/jmap/download/${accountId}/${blobId}/${name}`, {}, env);
}

/** Downloads a blob and decodes it as UTF-8, whatever its media type. */
export async function downloadText(
  app: TestApp,
  accountId: string,
  blobId: string,
  name = "blob",
): Promise<string> {
  const res = await download(app, accountId, blobId, name);
  expect(res.status).toBe(200);
  return new TextDecoder().decode(await res.arrayBuffer());
}
