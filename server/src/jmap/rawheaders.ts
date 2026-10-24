/**
 * Header-block handling for the `headers` / `header:Name:asForm` Email properties and for
 * Email/import. Reads only the head of the raw message (bounded range read), never the body.
 */
import {
  decodeTextHeader,
  parseAddressList,
  parseDateHeader,
  parseMessageIds,
} from "../mail/headers";
import { utcDate } from "./util";

/** Bytes of a message read to find its header block. */
export const HEADER_READ_BYTES = 64 * 1024;

export type RawHeader = { name: string; value: string };

/** Byte string (one char per byte), the same convention as the runtime's Headers. */
export function bytesToByteString(bytes: Uint8Array): string {
  let out = "";
  for (let i = 0; i < bytes.length; i += 8192) {
    out += String.fromCharCode(...bytes.subarray(i, i + 8192));
  }
  return out;
}

/**
 * Splits the header block of `bytes` into fields. `value` is the raw text after the colon
 * (leading space kept, folding kept) as RFC 8621 `asRaw` wants it.
 */
export function parseHeaderBlock(bytes: Uint8Array): RawHeader[] {
  const text = bytesToByteString(bytes);
  const end = text.search(/\r?\n\r?\n/);
  const head = end >= 0 ? text.slice(0, end) : text;
  const out: RawHeader[] = [];
  for (const line of head.split(/\r?\n/)) {
    if (/^[ \t]/.test(line)) {
      const last = out[out.length - 1];
      if (last) last.value += `\r\n${line}`;
      continue;
    }
    const i = line.indexOf(":");
    if (i > 0) out.push({ name: line.slice(0, i), value: line.slice(i + 1) });
  }
  return out;
}

/** Byte-string -> proper Unicode text for headers that carry raw UTF-8 (RFC 6532). */
function unfold(value: string): string {
  return value.replace(/\r?\n[ \t]+/g, " ");
}

/** Headers as the runtime's Headers object, for `extractIngestHeaders` (Email/import). */
export function toHeaders(list: RawHeader[]): Headers {
  const h = new Headers();
  for (const { name, value } of list) {
    try {
      h.append(name, unfold(value).trim());
    } catch {
      // invalid header name/value for the Headers API: skip
    }
  }
  return h;
}

export type HeaderProperty = { name: string; form: string; all: boolean };

const FORMS = new Set([
  "asRaw",
  "asText",
  "asAddresses",
  "asGroupedAddresses",
  "asMessageIds",
  "asDate",
  "asURLs",
]);

/** Parses `header:Name[:asForm][:all]`; null when malformed. */
export function parseHeaderProperty(prop: string): HeaderProperty | null {
  if (!prop.startsWith("header:")) return null;
  const parts = prop.split(":");
  parts.shift();
  let all = false;
  if (parts.length > 1 && parts[parts.length - 1] === "all") {
    all = true;
    parts.pop();
  }
  let form = "asRaw";
  if (parts.length > 1 && FORMS.has(parts[parts.length - 1]!)) form = parts.pop()!;
  const name = parts.join(":");
  if (!name || (parts.length > 1 && !FORMS.has(form))) return null;
  return { name, form, all };
}

function convert(value: string, form: string): unknown {
  switch (form) {
    case "asRaw":
      return value;
    case "asText":
      return decodeTextHeader(unfold(value)) ?? "";
    case "asAddresses": {
      const list = parseAddressList(unfold(value));
      return list;
    }
    case "asGroupedAddresses":
      return [{ name: null, addresses: parseAddressList(unfold(value)) }];
    case "asMessageIds":
      return parseMessageIds(value);
    case "asDate": {
      const ms = parseDateHeader(unfold(value));
      return ms === null ? null : utcDate(ms);
    }
    case "asURLs":
      return [...value.matchAll(/<([^<>\s]+)>/g)].map((m) => m[1]!);
    default:
      return null;
  }
}

/** Value of a `header:` property for the given raw headers. */
export function headerPropertyValue(headers: RawHeader[], p: HeaderProperty): unknown {
  const matches = headers.filter((h) => h.name.toLowerCase() === p.name.toLowerCase());
  if (p.all) return matches.map((h) => convert(h.value, p.form));
  const last = matches[matches.length - 1];
  return last ? convert(last.value, p.form) : null;
}
