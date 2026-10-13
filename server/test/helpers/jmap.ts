/* oxlint-disable typescript/no-explicit-any -- JSON responses are read untyped in tests */
import { env } from "cloudflare:workers";
import { expect } from "vitest";
import { runDurableObjectAlarm } from "cloudflare:test";
import { Hono } from "hono";
import { jmapApp } from "../../src/jmap";
import type { Principal } from "../../src/jmap/types";
import { handleEmail } from "../../src/mail/ingest";
import { accountStub } from "../../src/store/subscribe";
import { buildRaw, ctx, fakeMessage, seedAccount, type RawOptions } from "./mail";

export const USING = ["urn:ietf:params:jmap:core", "urn:ietf:params:jmap:mail"];
export const USING_SUBMISSION = [...USING, "urn:ietf:params:jmap:submission"];

/** jmapApp mounted behind a middleware that injects the principal (what jmapAuth does). */
export function testApp(principal: Principal) {
  const app = new Hono<{ Bindings: Env; Variables: { principal: Principal } }>();
  app.use("*", async (c, next) => {
    c.set("principal", principal);
    await next();
  });
  app.route("/jmap", jmapApp);
  return app;
}

export type TestApp = ReturnType<typeof testApp>;
export type Call = [string, Record<string, unknown>, string];
export type Response = {
  methodResponses: [string, Record<string, any>, string][];
  createdIds?: Record<string, string>;
  sessionState: string;
};

export async function call(
  app: TestApp,
  methodCalls: Call[],
  using: string[] = USING_SUBMISSION,
  extra: Record<string, unknown> = {},
): Promise<Response> {
  const res = await app.request(
    "/jmap/api",
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ using, methodCalls, ...extra }),
    },
    env,
  );
  expect(res.status).toBe(200);
  return (await res.json()) as Response;
}

/** Creates a D1-seeded account + a test app for it. */
export async function setupAccount(accountId: string, addresses: string[]) {
  await seedAccount(accountId, addresses);
  const principal: Principal = {
    userId: `user-${accountId}`,
    email: addresses[0]!,
    accountIds: [accountId],
  };
  const app = testApp(principal);
  const mailboxes = (await call(app, [["Mailbox/get", { accountId }, "m"]])).methodResponses[0]![1]
    .list as { id: string; role: string | null }[];
  const box = (role: string) => mailboxes.find((m) => m.role === role)!.id;
  return { accountId, app, principal, box };
}

/** Delivers a message through the real email() handler and runs the parse alarm. */
export async function deliver(
  accountId: string,
  to: string,
  opts: RawOptions = {},
  parse = true,
): Promise<void> {
  const { message } = fakeMessage(to, buildRaw({ to, ...opts }));
  await handleEmail(message, env, ctx);
  if (parse) await runDurableObjectAlarm(accountStub(env, accountId));
}

export function resp(r: Response, i = 0) {
  const [name, args] = r.methodResponses[i]!;
  return { name, args };
}
