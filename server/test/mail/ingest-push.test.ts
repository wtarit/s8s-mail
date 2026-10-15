import { env } from "cloudflare:workers";
import { runDurableObjectAlarm } from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";
import { accountStub, subscribeToAccount } from "../../src/store/subscribe";
import { buildRaw, seedAccount } from "../helpers/mail";
import { deliver } from "../helpers/ingest";

describe("push", () => {
  it("sends a StateChange to WebSocket subscribers after ingest and after parse", async () => {
    await seedAccount("ing-push", ["push@example.com"]);
    const stub = accountStub(env, "ing-push");
    const ws = await subscribeToAccount(env, "ing-push");
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
    expect(Object.keys(first.changed)).toEqual(["ing-push"]);
    expect(Object.keys(first.changed["ing-push"]!).toSorted()).toEqual([
      "Email",
      "EmailDelivery",
      "Mailbox",
      "Thread",
    ]);
    expect(Number(second.changed["ing-push"]!.Email)).toBeGreaterThan(
      Number(first.changed["ing-push"]!.Email),
    );
    expect(second.changed["ing-push"]).toEqual(await stub.getState());
    ws.close();
  });

  it("rejects non-WebSocket requests to /subscribe", async () => {
    const res = await accountStub(env, "ing-push-http").fetch("https://do/subscribe");
    expect(res.status).toBe(426);
  });
});
