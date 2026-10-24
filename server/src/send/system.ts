import { buildMime } from "../mime/build";
import type { SendProvider, SystemMail } from "./types";
import { SendError } from "./types";

/** Parses `Name <addr@host>` or a bare `addr@host`. */
export function parseMailbox(value: string): { name: string | null; email: string } {
  const m = /^\s*(?:"((?:[^"\\]|\\.)*)"|([^<>"]*?))\s*<([^<>\s]+)>\s*$/.exec(value);
  if (m) {
    const name = (m[1] !== undefined ? m[1].replace(/\\(.)/g, "$1") : (m[2] ?? "")).trim();
    return { name: name || null, email: m[3]! };
  }
  return { name: null, email: value.trim() };
}

/**
 * Builds a simple text (+ html) message from `from` and sends it through `provider`.
 * Throws `SendError`; callers (magic link, invite) decide how to surface failures.
 */
export async function sendSystemMailVia(
  provider: SendProvider,
  fromHeader: string,
  mail: SystemMail,
): Promise<void> {
  const from = parseMailbox(fromHeader);
  const domain = from.email.slice(from.email.lastIndexOf("@") + 1);
  if (!from.email.includes("@")) {
    throw new SendError("SYSTEM_MAIL_FROM is not a valid address", false, "notConfigured");
  }
  const { raw } = await buildMime(
    {
      from: [from],
      to: [{ email: mail.to }],
      subject: mail.subject,
      bodyValues: { t: { value: mail.text }, ...(mail.html ? { h: { value: mail.html } } : {}) },
      textBody: [{ partId: "t", type: "text/plain" }],
      htmlBody: mail.html ? [{ partId: "h", type: "text/html" }] : undefined,
      headers: [{ name: "Auto-Submitted", value: "auto-generated" }],
    },
    { fetchBlob: async () => null, messageIdDomain: domain, includeBcc: false },
  );
  await provider.send({ mailFrom: from.email, rcptTo: [mail.to.trim()], raw });
}
