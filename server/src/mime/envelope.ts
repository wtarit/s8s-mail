import type { EmailCreate } from "./types";
import { MimeBuildError } from "./types";

/**
 * SMTP envelope for a JMAP email: MAIL FROM is the Sender (if any) else the first From
 * address; RCPT TO is To + Cc + Bcc, bare addr-specs, deduplicated case-insensitively.
 */
export function envelopeFromEmail(
  email: Pick<EmailCreate, "from" | "sender" | "to" | "cc" | "bcc">,
): { mailFrom: string; rcptTo: string[] } {
  const mailFrom = (email.sender?.[0] ?? email.from[0])?.email?.trim();
  if (!mailFrom) throw new MimeBuildError("No From address", "from");
  const seen = new Set<string>();
  const rcptTo: string[] = [];
  for (const list of [email.to, email.cc, email.bcc]) {
    for (const a of list ?? []) {
      const addr = a.email.trim();
      const key = addr.toLowerCase();
      if (addr && !seen.has(key)) {
        seen.add(key);
        rcptTo.push(addr);
      }
    }
  }
  return { mailFrom, rcptTo };
}

const B = [98, 99, 99, 58]; // "bcc:" lower-case, matched case-insensitively

/**
 * Removes the Bcc header (and its folded continuation lines) from the header section of a
 * raw message. The body is untouched. Returns the input itself when there is no Bcc header.
 */
export function removeBccHeader(raw: Uint8Array): Uint8Array {
  const n = raw.length;
  let pos = 0;
  while (pos < n) {
    // Find end of this line (LF), tolerating bare LF.
    let eol = raw.indexOf(10, pos);
    if (eol < 0) eol = n - 1;
    const lineLen = eol - pos + 1;
    const blank = lineLen === 1 || (lineLen === 2 && raw[pos] === 13);
    if (blank) return raw; // end of headers, no Bcc found
    if (isBcc(raw, pos, eol)) {
      let end = eol + 1;
      // Continuation lines start with SP or HT.
      while (end < n && (raw[end] === 32 || raw[end] === 9)) {
        const next = raw.indexOf(10, end);
        end = next < 0 ? n : next + 1;
      }
      const out = new Uint8Array(n - (end - pos));
      out.set(raw.subarray(0, pos), 0);
      out.set(raw.subarray(end), pos);
      return out;
    }
    pos = eol + 1;
  }
  return raw;
}

function isBcc(raw: Uint8Array, pos: number, eol: number): boolean {
  if (eol - pos < 4) return false;
  for (let i = 0; i < 4; i++) {
    let c = raw[pos + i]!;
    if (c >= 65 && c <= 90) c += 32;
    if (c !== B[i]) return false;
  }
  return true;
}
