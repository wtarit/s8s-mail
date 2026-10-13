import PostalMime from "postal-mime";
import type { BuildMimeOptions, EmailCreate } from "../src/mime";

export const dec = new TextDecoder();
export const enc = new TextEncoder();

export function blobStore(blobs: Record<string, Uint8Array>): BuildMimeOptions["fetchBlob"] {
  return async (id) => blobs[id] ?? null;
}

export const baseOptions: BuildMimeOptions = {
  fetchBlob: async () => null,
  messageIdDomain: "example.com",
  includeBcc: false,
  now: new Date("2026-10-12T08:30:00Z"),
};

export const baseEmail: EmailCreate = {
  from: [{ name: "Alice Example", email: "alice@example.com" }],
  to: [{ email: "bob@example.com" }],
  subject: "Hello",
  bodyValues: { t: { value: "Hi Bob" } },
  textBody: [{ partId: "t", type: "text/plain" }],
};

export function parse(raw: Uint8Array) {
  return PostalMime.parse(raw);
}

/** Raw message as text (messages built here are 7-bit clean). */
export function rawText(raw: Uint8Array): string {
  return dec.decode(raw);
}

export function headerSection(raw: Uint8Array): string {
  const t = rawText(raw);
  return t.slice(0, t.indexOf("\r\n\r\n"));
}
