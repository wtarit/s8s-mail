/**
 * Blob id scheme (JMAP blobIds are `Id`s: only [A-Za-z0-9_-], so no dots).
 *
 *  - Raw message:  `M` + 32 lowercase hex chars (128 random bits), e.g. `M3f9a...`.
 *                  R2 key: `${accountId}/${blobId}`. This is Email.blobId.
 *  - Message part: `${messageBlobId}-${partId}`, e.g. `M3f9a...-1`. The message blob id
 *                  never contains `-`, so the first `-` splits the two. partId "1" is the
 *                  text/plain body, "2" the text/html body, "3".. the attachments in order
 *                  (see BodyPart in ./types.ts). R2 key: `${accountId}/${partBlobId}`.
 *                  The parse alarm materializes (best effort, at most MAX_PART_OBJECTS per
 *                  message) the decoded part content under that key, so serving a body or
 *                  attachment is one R2 read with no MIME parsing. If the object is
 *                  missing, the JMAP layer must re-parse the raw message (expensive on Free).
 *  - Uploads (JMAP upload endpoint) are a separate scheme owned by the JMAP layer; use a
 *    different prefix (e.g. `U`) so the two never collide.
 */

const HEX = "0123456789abcdef";

/** Random lowercase hex string of `bytes` bytes. */
export function randomHex(bytes: number): string {
  const buf = crypto.getRandomValues(new Uint8Array(bytes));
  let out = "";
  for (const b of buf) out += HEX[b >> 4]! + HEX[b & 15]!;
  return out;
}

/** New opaque id for a raw inbound message blob. */
export function newMessageBlobId(): string {
  return `M${randomHex(16)}`;
}

/** Blob id of one decoded part of a message. */
export function partBlobId(messageBlobId: string, partId: string): string {
  return `${messageBlobId}-${partId}`;
}

/** Splits a blob id into the message blob id and (if a part blob) its partId. */
export function parseBlobId(blobId: string): { messageBlobId: string; partId: string | null } {
  const i = blobId.indexOf("-");
  return i < 0
    ? { messageBlobId: blobId, partId: null }
    : { messageBlobId: blobId.slice(0, i), partId: blobId.slice(i + 1) };
}

/** R2 object key of any blob (message or part) of an account. */
export function blobKey(accountId: string, blobId: string): string {
  return `${accountId}/${blobId}`;
}

/** Max part objects materialized per message (Workers Free: 50 subrequests per invocation). */
export const MAX_PART_OBJECTS = 40;

/** Opaque JMAP object id: one prefix letter + 24 hex chars (valid RFC 8620 §1.2 Id). */
export function newId(prefix: "e" | "t" | "b"): string {
  return `${prefix}${randomHex(12)}`;
}
