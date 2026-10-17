import type { AccountState, StateChangeMessage } from "./types";

/**
 * Accepts `GET /subscribe` WebSocket upgrades on the account DO. Anything else is 404.
 * `init` records the accountId passed in the query string.
 */
export function acceptSubscription(
  ctx: DurableObjectState,
  request: Request,
  init: (accountId: string) => void,
): Response {
  const url = new URL(request.url);
  if (url.pathname !== "/subscribe") return new Response("Not found", { status: 404 });
  if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
    return new Response("Expected a WebSocket upgrade", { status: 426 });
  }
  const accountId = url.searchParams.get("accountId");
  if (accountId) init(accountId);

  const pair = new WebSocketPair();
  const client = pair[0];
  const server = pair[1];
  ctx.acceptWebSocket(server); // hibernation API: the DO can be evicted while idle
  return new Response(null, { status: 101, webSocket: client });
}

export function closeSubscriber(ws: WebSocket, code: number): void {
  try {
    ws.close(code >= 1000 && code < 5000 && code !== 1005 && code !== 1006 ? code : 1000);
  } catch {
    // already closed
  }
}

export function errorSubscriber(ws: WebSocket): void {
  try {
    ws.close(1011, "error");
  } catch {
    // already closed
  }
}

/** Sends the current JMAP StateChange to every connected subscriber. */
export function broadcastStateChange(
  ctx: DurableObjectState,
  accountId: string | null,
  getState: () => AccountState,
): void {
  const sockets = ctx.getWebSockets();
  if (sockets.length === 0 || !accountId) return;
  const message: StateChangeMessage = {
    "@type": "StateChange",
    changed: { [accountId]: getState() },
  };
  const payload = JSON.stringify(message);
  for (const ws of sockets) {
    try {
      ws.send(payload);
    } catch {
      // closing socket; the runtime delivers webSocketClose
    }
  }
}
