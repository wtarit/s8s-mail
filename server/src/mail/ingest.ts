import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { address, domain } from "../db/schema";
import { blobKey, newMessageBlobId } from "../store/blob";
import { accountStub } from "../store/subscribe";
import { extractIngestHeaders, normalizeRecipient } from "./headers";

/**
 * Inbound mail entry point, called by Cloudflare Email Routing once per recipient.
 *
 * Kept minimal on purpose: Workers Free gives 10 ms CPU per invocation, so there is no MIME
 * parsing here. Steps: resolve the recipient in D1, stream the raw message into R2, write
 * the header-derived row through the account DO. The DO parses the body later (alarm).
 *
 * Routing: exact address (after lowercasing and `+tag` stripping) wins. Only on a miss is the
 * recipient's domain consulted for a catch-all address (one extra D1 query, joined to the
 * catch-all's account). Unserved domains and domains without a catch-all are rejected.
 */
export async function handleEmail(
  message: ForwardableEmailMessage,
  env: Env,
  _ctx: ExecutionContext,
): Promise<void> {
  const recipient = normalizeRecipient(message.to);
  const db = drizzle(env.DB);
  let target = await db
    .select({ accountId: address.accountId })
    .from(address)
    .where(eq(address.address, recipient))
    .get();
  if (!target) {
    target = await db
      .select({ accountId: address.accountId })
      .from(domain)
      .innerJoin(address, eq(address.address, domain.catchAllAddress))
      .where(eq(domain.name, recipient.slice(recipient.lastIndexOf("@") + 1)))
      .get();
  }
  if (!target) {
    message.setReject("5.1.1 Recipient address rejected");
    return;
  }
  const { accountId } = target;

  // `message.raw` is a single-use stream and R2 needs a known length, so pipe it through a
  // FixedLengthStream instead of buffering up to 25 MiB.
  const blobId = newMessageBlobId();
  const key = blobKey(accountId, blobId);
  const { readable, writable } = new FixedLengthStream(message.rawSize);
  await Promise.all([
    env.BLOBS.put(key, readable, { httpMetadata: { contentType: "message/rfc822" } }),
    message.raw.pipeTo(writable),
  ]);

  try {
    await accountStub(env, accountId).ingest({
      accountId,
      blobId,
      size: message.rawSize,
      receivedAt: Date.now(),
      headers: extractIngestHeaders(message.headers),
      envelope: { mailFrom: message.from, rcptTo: message.to },
      mailboxRole: "inbox",
    });
  } catch (err) {
    // Do not leave an orphan blob; rethrow so Email Routing retries or bounces.
    await env.BLOBS.delete(key).catch(() => {});
    throw err;
  }
}
