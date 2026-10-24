import { env } from "cloudflare:workers";
import { runDurableObjectAlarm } from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";
import { accountStub, subscribeToAccount } from "../../src/store/subscribe";
import { setupAccount } from "../helpers/jmap";
import { buildRaw } from "../helpers/mail";
import { deliver, stateOf } from "../helpers/ingest";

describe("push", () => {
  it("sends a StateChange to WebSocket subscribers after ingest and after parse", async () => {
    const { app, accountId } = await setupAccount("ing-push", ["push@example.com"]);
    const stub = accountStub(env, accountId);
    const ws = await subscribeToAccount(env, accountId);
    const received: unknown[] = [];
    ws.addEventListener("message", (e) => received.push(JSON.parse(e.data as string)));

    // Incoming messages are ignored; "ping" is answered by the runtime.
    ws.send("ignored");

    await deliver("push@example.com", buildRaw());
    // First message: the delivery. Second: the parse alarm (which may fire on its own).
    await vi.waitFor(async () => {
      await runDurableObjectAlarm(stub);
      expect(received).toHaveLength(2);
    });
    type Msg = { "@type": string; changed: Record<string, Record<string, string>> };
    const [first, second] = received as [Msg, Msg];
    expect(first["@type"]).toBe("StateChange");
    expect(Object.keys(first.changed)).toEqual([accountId]);
    expect(Object.keys(first.changed[accountId]!).toSorted()).toEqual([
      "Email",
      "EmailDelivery",
      "Mailbox",
      "Thread",
    ]);
    // The parse changes the email (preview, ...), not the delivery.
    expect(second.changed[accountId]!.Email).not.toBe(first.changed[accountId]!.Email);
    // The pushed states are the ones JMAP reports.
    const pushed = second.changed[accountId]!;
    expect(pushed.Email).toBe(await stateOf(app, accountId, "Email"));
    expect(pushed.Mailbox).toBe(await stateOf(app, accountId, "Mailbox"));
    expect(pushed.Thread).toBe(await stateOf(app, accountId, "Thread"));
    ws.close();
  });

  it("rejects non-WebSocket requests to /subscribe", async () => {
    const res = await accountStub(env, "ing-push-http").fetch("https://do/subscribe");
    expect(res.status).toBe(426);
  });
});
