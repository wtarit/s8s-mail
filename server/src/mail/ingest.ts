/**
 * Inbound mail entry point, called by Cloudflare Email Routing.
 *
 * Stub: the real ingest (address -> account lookup in D1, raw message to R2, then an RPC
 * to the account DO) lives in a later task. Keep this handler minimal: Workers Free gives
 * 10 ms CPU per invocation, so defer heavy MIME parsing.
 */
export async function handleEmail(
  message: ForwardableEmailMessage,
  _env: Env,
  _ctx: ExecutionContext,
): Promise<void> {
  console.log("email received", { from: message.from, to: message.to, size: message.rawSize });
}
