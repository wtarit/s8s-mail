/**
 * JMAP push over Server-Sent Events (RFC 8620 §7.3).
 *
 * The stream is held by this stateless Worker invocation, never by a Durable Object: for
 * each of the principal's accounts it opens a hibernatable WebSocket to the account DO
 * (`subscribeToAccount`) and relays every StateChange as an SSE `state` event. When the
 * client disconnects the sockets are closed and the DOs can hibernate.
 */
import type { Context } from "hono";
import { accountStub, subscribeToAccount } from "../store/subscribe";
import type { StateChangeMessage } from "../store/types";
import type { JmapEnv } from "./types";

export const PING_MIN = 10;
export const PING_MAX = 300;

export function clampPing(value: string | undefined): number {
  const n = Number(value);
  if (!value || !Number.isFinite(n) || n <= 0) return 0;
  return Math.min(PING_MAX, Math.max(PING_MIN, Math.floor(n)));
}

export async function handleEventSource(c: Context<JmapEnv>): Promise<Response> {
  const principal = c.get("principal");
  const types = (c.req.query("types") ?? "*").trim();
  const filter =
    types === "*" || types === "" ? null : new Set(types.split(",").map((t) => t.trim()));
  const closeAfterState = c.req.query("closeafter") === "state";
  const ping = clampPing(c.req.query("ping"));
  const env = c.env;
  const signal = c.req.raw.signal;

  const encoder = new TextEncoder();
  const sockets: WebSocket[] = [];
  let timer: ReturnType<typeof setInterval> | undefined;
  let closed = false;
  let controllerRef: ReadableStreamDefaultController<Uint8Array> | undefined;

  const cleanup = () => {
    if (closed) return;
    closed = true;
    if (timer !== undefined) clearInterval(timer);
    for (const ws of sockets) {
      try {
        ws.close(1000, "client gone");
      } catch {
        // already closed
      }
    }
    try {
      controllerRef?.close();
    } catch {
      // stream already closed
    }
  };
  const send = (text: string) => {
    if (closed) return;
    try {
      controllerRef?.enqueue(encoder.encode(text));
    } catch {
      cleanup();
    }
  };
  const emitState = (changed: StateChangeMessage["changed"], initial: boolean) => {
    const out: Record<string, Record<string, string>> = {};
    for (const [accountId, states] of Object.entries(changed)) {
      if (!principal.accountIds.includes(accountId)) continue;
      const kept = Object.entries(states).filter(([type]) => !filter || filter.has(type));
      if (kept.length > 0) out[accountId] = Object.fromEntries(kept);
    }
    if (Object.keys(out).length === 0) return;
    send(`event: state\ndata: ${JSON.stringify({ "@type": "StateChange", changed: out })}\n\n`);
    if (closeAfterState && !initial) cleanup();
  };

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      controllerRef = controller;
      send(": connected\n\n"); // flush headers right away
      try {
        for (const accountId of principal.accountIds) {
          const ws = await subscribeToAccount(env, accountId);
          if (closed) {
            ws.close(1000, "client gone");
            return;
          }
          sockets.push(ws);
          ws.addEventListener("message", (ev) => {
            if (typeof ev.data !== "string" || ev.data === "pong") return;
            try {
              const msg = JSON.parse(ev.data) as StateChangeMessage;
              if (msg["@type"] === "StateChange") emitState(msg.changed, false);
            } catch {
              // ignore malformed frames
            }
          });
          ws.addEventListener("close", cleanup);
          ws.addEventListener("error", cleanup);
        }
        if (!closeAfterState) {
          // Initial state so the client can detect changes it missed while disconnected.
          const changed: StateChangeMessage["changed"] = {};
          for (const accountId of principal.accountIds) {
            changed[accountId] = await accountStub(env, accountId).getState();
          }
          emitState(changed, true);
        }
      } catch (err) {
        console.error("eventsource setup failed", err);
        cleanup();
        return;
      }
      if (ping > 0) {
        timer = setInterval(
          () => send(`event: ping\ndata: ${JSON.stringify({ interval: ping })}\n\n`),
          ping * 1000,
        );
      }
    },
    cancel() {
      cleanup();
    },
  });
  signal.addEventListener("abort", cleanup);

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      "X-Accel-Buffering": "no",
    },
  });
}
