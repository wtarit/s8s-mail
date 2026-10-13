import type { SendProvider } from "./types";

/**
 * Bytes of a provider's raw-message limit reserved for everything that is not attachment
 * payload. Budget (deliberately generous, the check is advisory to the user but a hard
 * limit at the provider):
 *   -   8 KiB  message headers (addresses, subject, References chain, custom headers)
 *   -  16 KiB  per-attachment part headers (up to 32 attachments x 512 B, incl. RFC 2231 names)
 *   - 104 KiB  text/plain + text/html bodies after quoted-printable expansion
 *   = 128 KiB
 */
export const MESSAGE_OVERHEAD_ALLOWANCE = 128 * 1024;

/** 57 payload bytes become one 76-char base64 line plus CRLF = 78 bytes on the wire. */
const RAW_PER_LINE = 57;
const WIRE_PER_LINE = 78;

/** Wire size (bytes) of `n` payload bytes as a base64 MIME body with 76-column lines. */
export function base64WireSize(n: number): number {
  if (n <= 0) return 0;
  const chars = Math.ceil(n / 3) * 4;
  return chars + Math.ceil(chars / 76) * 2;
}

/**
 * The largest total attachment size (unencoded bytes) to advertise as JMAP
 * `maxSizeAttachmentsPerEmail` for `provider`:
 *
 *   avail = maxMessageBytes - MESSAGE_OVERHEAD_ALLOWANCE
 *   whole 78-byte lines carry 57 payload bytes each; the remainder carries
 *   floor((rest - 2) / 4) * 3 bytes (after its trailing CRLF).
 *
 * That is ~73% of the raw limit minus the allowance. Pad bytes and part headers of
 * individual attachments are covered by the allowance.
 */
export function maxAttachmentBytes(provider: SendProvider): number {
  const avail = provider.maxMessageBytes - MESSAGE_OVERHEAD_ALLOWANCE;
  if (avail <= 0) return 0;
  const lines = Math.floor(avail / WIRE_PER_LINE);
  const rest = avail - lines * WIRE_PER_LINE;
  const tail = rest > 2 ? Math.floor((rest - 2) / 4) * 3 : 0;
  return lines * RAW_PER_LINE + tail;
}
