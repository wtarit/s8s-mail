/**
 * Push subscription helper for the JMAP layer.
 *
 * The SSE endpoint (`eventSourceUrl`) is held by a stateless Worker invocation, which calls
 * `subscribeToAccount()` for each account in the session and relays every message as an SSE
 * `event: state` frame. The DO side uses the hibernation API, so an idle subscription costs
 * the DO nothing. Never hold an SSE response inside the DO.
 *
 * Messages are JSON JMAP StateChange objects (RFC 8620 §7.1):
 *   {"@type":"StateChange","changed":{"<accountId>":{"Email":"12","Mailbox":"9","Thread":"3","EmailDelivery":"4"}}}
 *
 * Equivalent raw form: `stub.fetch("https://do/subscribe", { headers: { Upgrade: "websocket" } })`
 * then `response.webSocket.accept()`. Sending "ping" yields "pong" without waking the DO.
 */

export function accountStub(env: Pick<Env, "ACCOUNT">, accountId: string) {
  return env.ACCOUNT.get(env.ACCOUNT.idFromName(accountId));
}

/** Opens and accepts a WebSocket to the account DO. The caller owns closing it. */
export async function subscribeToAccount(
  env: Pick<Env, "ACCOUNT">,
  accountId: string,
): Promise<WebSocket> {
  const response = await accountStub(env, accountId).fetch(
    `https://do/subscribe?accountId=${encodeURIComponent(accountId)}`,
    { headers: { Upgrade: "websocket" } },
  );
  const ws = response.webSocket;
  if (!ws) throw new Error(`subscribe failed: ${response.status}`);
  ws.accept();
  return ws;
}
