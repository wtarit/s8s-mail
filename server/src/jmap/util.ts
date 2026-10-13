import { MethodError } from "./errors";

/** RFC 8620 UTCDate: "2026-10-12T03:00:00Z" (no fractional seconds). */
export function utcDate(ms: number): string {
  return new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z");
}

/** Parses a JMAP date-time to ms since epoch, or null. */
export function parseDate(value: string): number | null {
  const t = Date.parse(value);
  return Number.isNaN(t) ? null : t;
}

/** JSON Pointer token unescape (RFC 6901). */
export function unescapePointerToken(token: string): string {
  return token.replace(/~1/g, "/").replace(/~0/g, "~");
}

/** Hex SHA-256 prefix; used for stable ids and the session state. */
export async function shortHash(text: string, bytes = 12): Promise<string> {
  const digest = new Uint8Array(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)),
  );
  let out = "";
  for (const b of digest.subarray(0, bytes)) out += b.toString(16).padStart(2, "0");
  return out;
}

/** Stable Identity id for an address (JMAP Ids allow only [A-Za-z0-9_-]). */
export async function identityIdFor(address: string): Promise<string> {
  return `i${await shortHash(address.toLowerCase())}`;
}

/** RFC 8621 §2.1 keyword syntax: 1-255 chars of %x21-7E except ( ) { ] % * " \ */
export function isValidKeyword(keyword: string): boolean {
  if (keyword.length < 1 || keyword.length > 255) return false;
  for (const ch of keyword) {
    const c = ch.charCodeAt(0);
    if (c < 0x21 || c > 0x7e || '(){]%*"\\'.includes(ch)) return false;
  }
  return true;
}

/** JMAP Id: [A-Za-z0-9_-], 1-255 octets. */
export const ID_RE = /^[A-Za-z0-9_-]{1,255}$/;

export function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/** Throws requestTooLarge when `count` exceeds `max`. */
export function checkCount(count: number, max: number, what: string): void {
  if (count > max) {
    throw new MethodError("requestTooLarge", `At most ${max} ${what} per call`);
  }
}

/** Escapes text for inclusion in HTML (SearchSnippet values). */
export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
