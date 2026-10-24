import type { SendEnv } from "./base";
import { MailgunProvider } from "./mailgun";
import { sendSystemMailVia } from "./system";
import type { SendProvider, SystemMail } from "./types";
import { SendError } from "./types";

export * from "./types";
export type { SendEnv } from "./base";
export { MESSAGE_OVERHEAD_ALLOWANCE, base64WireSize, maxAttachmentBytes } from "./limits";
export { MailgunProvider } from "./mailgun";
export type { MailgunConfig } from "./mailgun";
export { parseMailbox, sendSystemMailVia } from "./system";

/**
 * Returns the deployment's configured provider (env.MAIL_PROVIDER). Construction is
 * cheap and does no I/O; a provider that is selected but unusable (no MAILGUN_API
 * secret) fails at `send()` with a non-retryable SendError, so
 * its limits can still be advertised.
 */
export function getSendProvider(env: Env): SendProvider {
  const e = env as Env & SendEnv;
  switch (e.MAIL_PROVIDER) {
    case "mailgun":
      return new MailgunProvider({
        apiKey: e.MAILGUN_API,
        domain: e.MAILGUN_DOMAIN,
        region: e.MAILGUN_REGION === "eu" ? "eu" : "us",
      });
    default:
      throw new SendError(
        `Unknown MAIL_PROVIDER "${String(e.MAIL_PROVIDER)}" (expected "mailgun")`,
        false,
        "notConfigured",
      );
  }
}

/**
 * Builds a simple MIME message from `mail` (From = env.SYSTEM_MAIL_FROM) and
 * sends it through the configured provider. Throws `SendError`.
 */
export async function sendSystemMail(env: Env, mail: SystemMail): Promise<void> {
  await sendSystemMailVia(getSendProvider(env), env.SYSTEM_MAIL_FROM, mail);
}
