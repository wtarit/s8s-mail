/**
 * Small, fast header helpers for `email()`: RFC 2047 encoded-word decoding, RFC 5322
 * address-list parsing and Message-ID/Date extraction. Deliberately not a MIME parser:
 * Workers Free gives 10 ms CPU per invocation, and these run on every inbound message.
 */
import type { EmailAddress, IngestInput } from "../store/types";

// --- RFC 2047 ---------------------------------------------------------------------

const ENCODED_WORD = /=\?([^?\s]+)\?([bBqQ])\?([^?\s]*)\?=/g;
// Whitespace between two adjacent encoded-words is not part of the text (RFC 2047 6.2).
const ENCODED_WORD_RUN = /=\?[^?\s]+\?[bBqQ]\?[^?\s]*\?=(?:\s+=\?[^?\s]+\?[bBqQ]\?[^?\s]*\?=)*/g;

function decodeBytes(bytes: Uint8Array, charset: string): string {
  // RFC 2231 allows "charset*language"; the language part is irrelevant here.
  const label = charset.split("*")[0]!.toLowerCase();
  try {
    return new TextDecoder(label).decode(bytes);
  } catch {
    return new TextDecoder("utf-8").decode(bytes);
  }
}

function qBytes(text: string): Uint8Array {
  const out: number[] = [];
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (c === "_") out.push(0x20);
    else if (c === "=" && /^[0-9a-fA-F]{2}$/.test(text.slice(i + 1, i + 3))) {
      out.push(parseInt(text.slice(i + 1, i + 3), 16));
      i += 2;
    } else out.push(c.charCodeAt(0) & 0xff);
  }
  return Uint8Array.from(out);
}

function bBytes(text: string): Uint8Array | null {
  try {
    const bin = atob(text);
    return Uint8Array.from(bin, (ch) => ch.charCodeAt(0));
  } catch {
    return null;
  }
}

/** Decodes a run of adjacent encoded-words; consecutive words of one charset are decoded together. */
function decodeRun(run: string): string {
  const words = [...run.matchAll(ENCODED_WORD)];
  let out = "";
  let pendingCharset = "";
  let pending: number[] = [];
  const flush = () => {
    if (pending.length > 0) out += decodeBytes(Uint8Array.from(pending), pendingCharset);
    pending = [];
  };
  for (const w of words) {
    const [whole, charset, enc, text] = w as unknown as [string, string, string, string];
    const bytes = enc.toLowerCase() === "b" ? bBytes(text) : qBytes(text);
    if (!bytes) {
      flush();
      out += whole;
      continue;
    }
    if (charset.toLowerCase() !== pendingCharset.toLowerCase()) flush();
    pendingCharset = charset;
    for (const b of bytes) pending.push(b);
  }
  flush();
  return out;
}

/** Decodes RFC 2047 encoded-words (`=?UTF-8?B?...?=`, `=?TIS-620?Q?...?=`) in a header value. */
export function decodeEncodedWords(value: string): string {
  if (!value.includes("=?")) return value;
  return value.replace(ENCODED_WORD_RUN, decodeRun);
}

/**
 * The runtime exposes header values as byte strings. A sender that put raw UTF-8 in a
 * header (RFC 6532) shows up as mojibake; recover it when the bytes are valid UTF-8.
 */
export function fixRawUtf8(value: string): string {
  if (!/[\u0080-ÿ]/.test(value)) return value;
  const bytes = new Uint8Array(value.length);
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code > 0xff) return value; // already real Unicode
    bytes[i] = code;
  }
  try {
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes);
  } catch {
    return value;
  }
}

/** Decoded text header (Subject, ...): unfolded, raw UTF-8 and encoded-words decoded, trimmed. */
export function decodeTextHeader(value: string | null): string | null {
  if (value === null) return null;
  const text = decodeEncodedWords(fixRawUtf8(value.replace(/\r?\n[ \t]+/g, " "))).trim();
  return text === "" ? null : text;
}

// --- RFC 5322 addresses -------------------------------------------------------------

/** Splits an address-list on top-level commas, flattening groups (`Team: a@x, b@y;`). */
function splitAddressList(value: string): string[] {
  const segments: string[] = [];
  let cur = "";
  let quoted = false;
  let angle = false;
  let comment = 0;
  for (let i = 0; i < value.length; i++) {
    const c = value[i]!;
    if (quoted) {
      cur += c;
      if (c === "\\" && i + 1 < value.length) cur += value[++i]!;
      else if (c === '"') quoted = false;
      continue;
    }
    if (comment > 0) {
      cur += c;
      if (c === "\\" && i + 1 < value.length) cur += value[++i]!;
      else if (c === "(") comment++;
      else if (c === ")") comment--;
      continue;
    }
    if (c === '"') {
      quoted = true;
      cur += c;
    } else if (c === "(") {
      comment = 1;
      cur += c;
    } else if (c === "<") {
      angle = true;
      cur += c;
    } else if (c === ">") {
      angle = false;
      cur += c;
    } else if (!angle && c === ":") {
      cur = ""; // group display name: dropped, members follow
    } else if (!angle && (c === "," || c === ";")) {
      segments.push(cur);
      cur = "";
    } else cur += c;
  }
  segments.push(cur);
  return segments;
}

/** Removes comments and unquotes a display-name phrase. */
function cleanPhrase(raw: string): string {
  let out = "";
  let comment = 0;
  for (let i = 0; i < raw.length; i++) {
    const c = raw[i]!;
    if (comment > 0) {
      if (c === "\\") i++;
      else if (c === "(") comment++;
      else if (c === ")") comment--;
    } else if (c === "(") comment = 1;
    else if (c === "\\" && i + 1 < raw.length) out += raw[++i]!;
    else if (c !== '"') out += c;
  }
  return out.replace(/\s+/g, " ").trim();
}

function firstComment(raw: string): string {
  const m = /\(((?:[^()\\]|\\.)*)\)/.exec(raw);
  return m ? cleanPhrase(m[1]!) : "";
}

/**
 * Parses an address-list header (From, To, Cc, Reply-To, Sender) into JMAP EmailAddresses.
 * Display names have encoded-words decoded; groups are flattened; unparseable entries
 * (no `@`) are dropped.
 */
export function parseAddressList(value: string | null): EmailAddress[] {
  if (!value) return [];
  const out: EmailAddress[] = [];
  for (const seg of splitAddressList(fixRawUtf8(value.replace(/\r?\n[ \t]+/g, " ")))) {
    const lt = seg.indexOf("<");
    const gt = seg.indexOf(">", lt + 1);
    let email: string;
    let nameRaw: string;
    if (lt >= 0 && gt > lt) {
      email = seg.slice(lt + 1, gt);
      nameRaw = seg.slice(0, lt);
    } else {
      // Bare addr-spec, optionally with a legacy "(Name)" comment.
      email = seg.replace(/\((?:[^()\\]|\\.)*\)/g, "");
      nameRaw = firstComment(seg);
    }
    // Obsolete source route (<@a,@b:user@c>): keep only the addr-spec.
    email = email.slice(email.lastIndexOf(":") + 1).replace(/[\s"]/g, "");
    if (!email.includes("@")) continue;
    const phrase = cleanPhrase(nameRaw);
    const name = decodeEncodedWords(phrase).trim();
    out.push({ name: name === "" ? null : name, email });
  }
  return out;
}

// --- Message-ID / Date ---------------------------------------------------------------

/** All `<id>` tokens of a Message-ID / In-Reply-To / References header, without brackets. */
export function parseMessageIds(value: string | null): string[] {
  if (!value) return [];
  return [...value.matchAll(/<([^<>\s]+)>/g)].map((m) => m[1]!);
}

/** Date header to ms since epoch, or null when absent or unparseable. */
export function parseDateHeader(value: string | null): number | null {
  if (!value) return null;
  const t = Date.parse(value.replace(/\([^)]*\)/g, "").trim());
  return Number.isNaN(t) ? null : t;
}

// --- Recipient + whole-message extraction ------------------------------------------------

/** Lowercases and drops the `+tag` of the local part: `Ana+news@Example.com` -> `ana@example.com`. */
export function normalizeRecipient(to: string): string {
  const addr = to.trim().replace(/^<|>$/g, "").toLowerCase();
  const at = addr.lastIndexOf("@");
  if (at < 0) return addr;
  const local = addr.slice(0, at);
  const plus = local.indexOf("+");
  return `${plus > 0 ? local.slice(0, plus) : local}${addr.slice(at)}`;
}

/** Header-derived fields for `AccountDO.ingest()` from the runtime's pre-parsed headers. */
export function extractIngestHeaders(headers: Headers): IngestInput["headers"] {
  return {
    messageId: parseMessageIds(headers.get("message-id"))[0] ?? null,
    inReplyTo: parseMessageIds(headers.get("in-reply-to")),
    references: parseMessageIds(headers.get("references")),
    subject: decodeTextHeader(headers.get("subject")),
    sentAt: parseDateHeader(headers.get("date")),
    from: parseAddressList(headers.get("from")),
    sender: parseAddressList(headers.get("sender")),
    to: parseAddressList(headers.get("to")),
    cc: parseAddressList(headers.get("cc")),
    replyTo: parseAddressList(headers.get("reply-to")),
  };
}
