/**
 * Low-level encoders for the MIME builder: quoted-printable, base64 with 76-column lines,
 * RFC 2047 encoded-words, RFC 2231 parameters and header folding.
 *
 * Hot paths (QP, base64) are single-pass typed-array loops that write straight into a
 * preallocated output buffer, to stay inside the 10 ms Workers Free CPU budget.
 */

const textEncoder = new TextEncoder();

export function utf8(s: string): Uint8Array {
  return textEncoder.encode(s);
}

const NON_ASCII = /[^\p{ASCII}]/u;
export function isAscii(s: string): boolean {
  return !NON_ASCII.test(s);
}

export function concat(chunks: Uint8Array[]): Uint8Array {
  let total = 0;
  for (const c of chunks) total += c.length;
  const out = new Uint8Array(total);
  let o = 0;
  for (const c of chunks) {
    out.set(c, o);
    o += c.length;
  }
  return out;
}

const HEX = utf8("0123456789ABCDEF");

/** Quoted-printable (RFC 2045) of `src`, which must already use CRLF line endings. */
export function qpEncode(src: Uint8Array): Uint8Array {
  const n = src.length;
  const out = new Uint8Array(n * 3 + Math.ceil(n / 8) + 16);
  let o = 0;
  let col = 0;
  for (let i = 0; i < n; i++) {
    const b = src[i]!;
    if (b === 13 && src[i + 1] === 10) {
      out[o++] = 13;
      out[o++] = 10;
      i++;
      col = 0;
      continue;
    }
    // Space/tab are literal unless they end a line (CRLF follows) or the data.
    const literal =
      (b >= 33 && b <= 126 && b !== 61) ||
      ((b === 32 || b === 9) && i + 1 < n && src[i + 1] !== 13);
    const need = literal ? 1 : 3;
    if (col + need > 75) {
      out[o++] = 61;
      out[o++] = 13;
      out[o++] = 10;
      col = 0;
    }
    if (literal) {
      out[o++] = b;
    } else {
      out[o++] = 61;
      out[o++] = HEX[b >> 4]!;
      out[o++] = HEX[b & 15]!;
    }
    col += need;
  }
  return out.subarray(0, o);
}

const B64 = utf8("ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/");

// 12-bit -> two base64 chars, stored as the in-memory byte pair (endianness independent), so
// the hot loop does two 16-bit stores per 3 input bytes instead of four byte stores.
const PAIRS = new Uint16Array(4096);
const CRLF16 = new Uint16Array(1);
{
  const pb = new Uint8Array(PAIRS.buffer);
  for (let i = 0; i < 4096; i++) {
    pb[2 * i] = B64[i >> 6]!;
    pb[2 * i + 1] = B64[i & 63]!;
  }
  new Uint8Array(CRLF16.buffer).set([13, 10]);
}

/** Base64 of `src` in 76-column lines, every line (including the last) ending in CRLF. */
export function base64Lines(src: Uint8Array): Uint8Array {
  const n = src.length;
  if (n === 0) return new Uint8Array(0);
  const chars = Math.ceil(n / 3) * 4;
  const total = chars + Math.ceil(chars / 76) * 2;
  const buf = new ArrayBuffer(total + (total & 1)); // even length for the Uint16Array view
  const out = new Uint8Array(buf);
  const out16 = new Uint16Array(buf);
  const crlf = CRLF16[0]!;
  const full = n - (n % 3);
  let o = 0; // index into out16 (2 bytes each)
  let col = 0;
  let i = 0;
  while (i < full) {
    const v = (src[i]! << 16) | (src[i + 1]! << 8) | src[i + 2]!;
    i += 3;
    out16[o++] = PAIRS[v >> 12]!;
    out16[o++] = PAIRS[v & 4095]!;
    col += 4;
    if (col === 76) {
      out16[o++] = crlf;
      col = 0;
    }
  }
  let b = o * 2;
  const rem = n - full;
  if (rem > 0) {
    const v = rem === 1 ? src[i]! << 16 : (src[i]! << 16) | (src[i + 1]! << 8);
    out[b++] = B64[v >> 18]!;
    out[b++] = B64[(v >> 12) & 63]!;
    out[b++] = rem === 2 ? B64[(v >> 6) & 63]! : 61;
    out[b++] = 61;
    col += 4;
  }
  if (col > 0) {
    out[b++] = 13;
    out[b++] = 10;
  }
  return out.subarray(0, total);
}

/** Plain base64 string of a (small) byte slice, for encoded-words. */
function b64Small(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]!);
  return btoa(s);
}

// ---------- RFC 2047 encoded-words ----------

function isQSafe(b: number): boolean {
  // Restricted Q set valid in every context (including phrases): alnum and ! * + - /
  return (
    (b >= 48 && b <= 57) ||
    (b >= 65 && b <= 90) ||
    (b >= 97 && b <= 122) ||
    b === 33 ||
    b === 42 ||
    b === 43 ||
    b === 45 ||
    b === 47
  );
}

function qByte(b: number): string {
  if (b === 32) return "_";
  if (isQSafe(b)) return String.fromCharCode(b);
  return "=" + String.fromCharCode(HEX[b >> 4]!, HEX[b & 15]!);
}

/** UTF-8 sequence length from its lead byte. */
function seqLen(lead: number): number {
  return lead < 0x80 ? 1 : lead >= 0xf0 ? 4 : lead >= 0xe0 ? 3 : lead >= 0xc0 ? 2 : 1;
}

/**
 * Encode `text` as RFC 2047 encoded-words (UTF-8), B or Q whichever is shorter, each word
 * at most 75 characters. Returns the words; join them with folding whitespace.
 */
export function encodeWords(text: string): string[] {
  const bytes = utf8(text);
  const n = bytes.length;
  if (n === 0) return [];
  let qLen = 0;
  for (let i = 0; i < n; i++) qLen += bytes[i] === 32 || isQSafe(bytes[i]!) ? 1 : 3;
  const bLen = Math.ceil(n / 3) * 4;
  const words: string[] = [];
  if (qLen <= bLen) {
    let cur = "";
    let i = 0;
    while (i < n) {
      const len = seqLen(bytes[i]!);
      let seq = "";
      for (let k = 0; k < len && i + k < n; k++) seq += qByte(bytes[i + k]!);
      if (cur.length + seq.length > 63) {
        words.push(`=?UTF-8?Q?${cur}?=`);
        cur = "";
      }
      cur += seq;
      i += len;
    }
    if (cur) words.push(`=?UTF-8?Q?${cur}?=`);
  } else {
    let i = 0;
    while (i < n) {
      let end = Math.min(i + 45, n);
      // Do not split a UTF-8 sequence across words.
      while (end < n && end > i + 1 && (bytes[end]! & 0xc0) === 0x80) end--;
      words.push(`=?UTF-8?B?${b64Small(bytes.subarray(i, end))}?=`);
      i = end;
    }
  }
  return words;
}

// ---------- header folding ----------

/** Replace CR/LF/TAB (header injection, folding) with spaces. */
export function oneLine(s: string): string {
  return s.replace(/[\r\n\t]+/g, " ");
}

/**
 * Join `tokens` after `Name:` with single spaces, folding (CRLF + space) between tokens so
 * lines stay within 78 characters where possible. Tokens are never split. The result ends
 * in CRLF.
 */
export function foldHeader(name: string, tokens: string[]): string {
  let out = name + ":";
  let lineLen = out.length;
  let lineHasToken = false;
  let firstLine = true;
  for (const tok of tokens) {
    if (lineLen + 1 + tok.length > 78 && (lineHasToken || firstLine)) {
      out += "\r\n " + tok;
      lineLen = 1 + tok.length;
      firstLine = false;
    } else {
      out += " " + tok;
      lineLen += 1 + tok.length;
    }
    lineHasToken = true;
  }
  return out + "\r\n";
}

/** Tokens for an unstructured header value (Subject, custom headers). */
export function unstructuredTokens(raw: string): string[] {
  const text = oneLine(raw);
  if (text === "") return [];
  const plain =
    isAscii(text) &&
    !/\p{Cc}/u.test(text) &&
    !text.includes("  ") &&
    text[0] !== " " &&
    text[text.length - 1] !== " " &&
    !text.includes("=?");
  if (plain) {
    const words = text.split(" ");
    if (words.every((w) => w.length <= 900)) return words;
  }
  return encodeWords(text);
}

const ATOM_WORD = /^[A-Za-z0-9!#$%&'*+\-/=?^_`{|}~]+$/;

/** Tokens for a display name (RFC 5322 phrase): atoms, a quoted-string, or encoded-words. */
export function phraseTokens(rawName: string): string[] {
  const name = oneLine(rawName).trim();
  if (name === "") return [];
  if (isAscii(name) && name.length <= 200 && !/\p{Cc}/u.test(name)) {
    const words = name.split(" ");
    if (words.every((w) => ATOM_WORD.test(w) && !w.includes("=?"))) return words;
    return ['"' + name.replace(/["\\]/g, "\\$&") + '"'];
  }
  return encodeWords(name);
}

// ---------- RFC 2231 parameters ----------

const ATTR_SAFE = /^[A-Za-z0-9!#$&+\-.^_`|~]$/;

function pctEncodeChar(ch: string): string {
  if (ATTR_SAFE.test(ch)) return ch;
  let s = "";
  for (const b of utf8(ch)) s += "%" + String.fromCharCode(HEX[b >> 4]!, HEX[b & 15]!);
  return s;
}

function quoted(v: string): string {
  return '"' + v.replace(/["\\]/g, "\\$&") + '"';
}

/**
 * `name="value"` parameter tokens. Non-ASCII values use RFC 2231 only: `name*=UTF-8''...`,
 * or `name*0*=`, `name*1*=` continuations when long. No ASCII `name=` fallback is added:
 * Gmail, Thunderbird and Apple Mail send the starred form alone, and parsers that see both
 * (postal-mime, deliberately) prefer the plain parameter, which would show the lossy
 * fallback instead of the real name. Each returned token is one parameter, without `;`.
 */
export function paramTokens(name: string, rawValue: string): string[] {
  const value = oneLine(rawValue)
    .replace(/[/\\]/g, "_")
    .replace(/\p{Cc}/gu, "");
  if (isAscii(value) && value.length <= 200) return [`${name}=${quoted(value)}`];
  const segments: string[] = [];
  let cur = "";
  for (const ch of value) {
    const enc = pctEncodeChar(ch);
    if (cur.length + enc.length > 54 && cur) {
      segments.push(cur);
      cur = "";
    }
    cur += enc;
  }
  if (cur) segments.push(cur);
  if (segments.length <= 1) return [`${name}*=UTF-8''${segments[0] ?? ""}`];
  return segments.map((seg, idx) =>
    idx === 0 ? `${name}*0*=UTF-8''${seg}` : `${name}*${idx}*=${seg}`,
  );
}

/** Append `;` to every token but the last. */
export function semicolons(tokens: string[]): string[] {
  return tokens.map((t, i) => (i < tokens.length - 1 ? t + ";" : t));
}
