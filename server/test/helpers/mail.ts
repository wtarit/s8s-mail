import { env } from "cloudflare:workers";
import { vi } from "vitest";

/** Seeds one account (D1 migrations are applied by helpers/setup.ts) with its addresses. */
export async function seedAccount(accountId: string, addresses: string[]): Promise<void> {
  const now = Date.now();
  await env.DB.prepare("INSERT OR IGNORE INTO mail_account (id, name, created_at) VALUES (?, ?, ?)")
    .bind(accountId, accountId, now)
    .run();
  for (const [i, addr] of addresses.entries()) {
    const at = addr.lastIndexOf("@");
    await env.DB.prepare("INSERT OR IGNORE INTO domain (name, created_at) VALUES (?, ?)")
      .bind(addr.slice(at + 1), now)
      .run();
    await env.DB.prepare(
      "INSERT OR IGNORE INTO address (address, local_part, domain, account_id, kind, created_at) VALUES (?, ?, ?, ?, ?, ?)",
    )
      .bind(
        addr,
        addr.slice(0, at),
        addr.slice(at + 1),
        accountId,
        i === 0 ? "primary" : "alias",
        now,
      )
      .run();
  }
}

export type RawOptions = {
  from?: string;
  to?: string;
  subject?: string;
  messageId?: string;
  inReplyTo?: string;
  references?: string;
  date?: string;
  text?: string;
  /** Adds a base64 attachment (multipart/mixed). */
  attachment?: { filename: string; mimeType: string; base64: string };
};

/** Builds a small RFC 5322 message with CRLF line endings. */
export function buildRaw(o: RawOptions = {}): string {
  const lines = [
    `From: ${o.from ?? "Bob <bob@example.com>"}`,
    `To: ${o.to ?? "ana@example.com"}`,
    `Subject: ${o.subject ?? "Hello"}`,
    `Date: ${o.date ?? "Mon, 12 Oct 2026 10:00:00 +0700"}`,
    `Message-ID: ${o.messageId ?? "<m1@example.com>"}`,
  ];
  if (o.inReplyTo) lines.push(`In-Reply-To: ${o.inReplyTo}`);
  if (o.references) lines.push(`References: ${o.references}`);
  lines.push("MIME-Version: 1.0");
  const text = o.text ?? "Hello Ana,\r\nthis is the body.";
  if (!o.attachment) {
    lines.push("Content-Type: text/plain; charset=utf-8", "", text);
  } else {
    const b = "BOUNDARY-x";
    lines.push(
      `Content-Type: multipart/mixed; boundary="${b}"`,
      "",
      `--${b}`,
      "Content-Type: text/plain; charset=utf-8",
      "",
      text,
      `--${b}`,
      `Content-Type: ${o.attachment.mimeType}; name="${o.attachment.filename}"`,
      `Content-Disposition: attachment; filename="${o.attachment.filename}"`,
      "Content-Transfer-Encoding: base64",
      "",
      o.attachment.base64,
      `--${b}--`,
    );
  }
  return lines.join("\r\n") + "\r\n";
}

/** Header block of a raw message as a Headers object (what Email Routing hands the handler). */
export function headersOf(raw: string): Headers {
  const head = raw.split("\r\n\r\n")[0]!.replace(/\r\n[ \t]+/g, " ");
  const headers = new Headers();
  for (const line of head.split("\r\n")) {
    const i = line.indexOf(":");
    if (i > 0) headers.append(line.slice(0, i), line.slice(i + 1).trim());
  }
  return headers;
}

export function fakeMessage(to: string, raw: string, from = "bob@example.com") {
  const bytes = new TextEncoder().encode(raw);
  const setReject = vi.fn<(reason: string) => void>();
  const message = {
    from,
    to,
    headers: headersOf(raw),
    rawSize: bytes.byteLength,
    raw: new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(bytes);
        controller.close();
      },
    }),
    setReject,
    forward: vi.fn(),
    reply: vi.fn(),
  } as unknown as ForwardableEmailMessage;
  return { message, setReject };
}

export const ctx = {
  waitUntil() {},
  passThroughOnException() {},
} as unknown as ExecutionContext;
