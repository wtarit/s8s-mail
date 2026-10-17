/* oxlint-disable typescript/no-explicit-any -- JSON responses are read untyped in tests */
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { clampPing } from "../../src/jmap/eventsource";
import { deliver, setupAccount } from "../helpers/jmap";

/** Reads from an SSE body until `done(text)` is true (or times out). */
async function readUntil(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  buffer: { text: string },
  done: (text: string) => boolean,
  timeoutMs = 5000,
): Promise<void> {
  const decoder = new TextDecoder();
  const deadline = Date.now() + timeoutMs;
  while (!done(buffer.text)) {
    const left = deadline - Date.now();
    if (left <= 0) throw new Error(`timeout; got: ${buffer.text}`);
    const r = await Promise.race([
      reader.read(),
      new Promise<null>((res) => setTimeout(() => res(null), left)),
    ]);
    if (r === null) throw new Error(`timeout; got: ${buffer.text}`);
    if (r.done) return;
    buffer.text += decoder.decode(r.value, { stream: true });
  }
}

const events = (text: string, name: string) =>
  [...text.matchAll(new RegExp(`event: ${name}\\ndata: (.*)\\n\\n`, "g"))].map((m) =>
    JSON.parse(m[1]!),
  );

describe("JMAP EventSource", () => {
  it("sends an initial state event, then a state event after an ingest", async () => {
    const { app, accountId } = await setupAccount("sse-1", ["sse-1@example.com"]);
    const res = await app.request("/jmap/eventsource?types=*&closeafter=no&ping=30", {}, env);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    const reader = res.body!.getReader();
    const buf = { text: "" };
    await readUntil(reader, buf, (t) => events(t, "state").length >= 1);
    const initial = events(buf.text, "state")[0];
    expect(initial["@type"]).toBe("StateChange");
    expect(Object.keys(initial.changed["sse-1"]).toSorted()).toEqual([
      "Email",
      "EmailDelivery",
      "Mailbox",
      "Thread",
    ]);

    await deliver(accountId, "sse-1@example.com", { subject: "Push me" }, false);
    await readUntil(reader, buf, (t) => events(t, "state").length >= 2);
    const next = events(buf.text, "state")[1];
    expect(next.changed["sse-1"].Email).not.toBe(initial.changed["sse-1"].Email);
    await reader.cancel();
  });

  it("filters by types and ends after the first change with closeafter=state", async () => {
    const { app, accountId } = await setupAccount("sse-2", ["sse-2@example.com"]);
    const res = await app.request(
      "/jmap/eventsource?types=Mailbox&closeafter=state&ping=0",
      {},
      env,
    );
    const reader = res.body!.getReader();
    const buf = { text: "" };
    await deliver(accountId, "sse-2@example.com", { subject: "x" }, false);
    await readUntil(reader, buf, (t) => events(t, "state").length >= 1);
    const ev = events(buf.text, "state")[0];
    expect(Object.keys(ev.changed["sse-2"])).toEqual(["Mailbox"]);
    // the stream is closed by the server
    const end = await Promise.race([
      (async () => {
        for (;;) {
          const r = await reader.read();
          if (r.done) return "closed";
        }
      })(),
      new Promise((r) => setTimeout(() => r("open"), 3000)),
    ]);
    expect(end).toBe("closed");
  });

  it("clamps the ping interval to 10-300 seconds", () => {
    expect(clampPing("30")).toBe(30);
    expect(clampPing("1")).toBe(10);
    expect(clampPing("99999")).toBe(300);
    expect(clampPing("0")).toBe(0);
    expect(clampPing(undefined)).toBe(0);
    expect(clampPing("abc")).toBe(0);
  });
});
