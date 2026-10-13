import { EmailMessage } from "cloudflare:email";
import { BaseProvider } from "./base";
import type { OutboundMessage, SendResult } from "./types";
import { SendError } from "./types";

export interface CloudflareConfig {
  /** The `send_email` binding (`env.EMAIL`); absent on Workers Free. */
  binding: SendEmail | undefined;
}

/** Cloudflare error codes where a later retry can succeed. */
const RETRYABLE = new Set([
  "E_RATE_LIMIT_EXCEEDED",
  // The daily quota resets; a delayed retry may succeed.
  "E_DAILY_LIMIT_EXCEEDED",
  "E_INTERNAL_SERVER_ERROR",
]);

/**
 * Maps a thrown `send()` error (standard `Error` with a `code` property, E_* values
 * from the Email Service docs) to a `SendError`. Codes not in the retryable list
 * (validation, header, sender/recipient, size, delivery failures) are permanent; an error
 * without any code (runtime/network fault) is treated as transient.
 */
export function mapCloudflareError(err: unknown): SendError {
  if (err instanceof SendError) return err;
  const code = (err as { code?: unknown } | null)?.code;
  const message = err instanceof Error ? err.message : String(err);
  if (typeof code === "string" && code.startsWith("E_")) {
    return new SendError(`Cloudflare Email Sending ${code}: ${message}`, RETRYABLE.has(code), code);
  }
  return new SendError(`Cloudflare Email Sending failed: ${message}`, true, "network");
}

/**
 * Cloudflare Email Sending via the `send_email` binding, Workers Paid only.
 *
 * The legacy raw path (`new EmailMessage(from, to, raw)`) takes ONE recipient per message,
 * so a message for N recipients is sent N times (sequentially) and counts N against the
 * account's sending quota. Per-message limits: 5 MiB, 50 recipients.
 * A partial failure (some recipients sent, a later one failed) is reported as a
 * non-retryable `partial` error so a retry cannot duplicate mail to the recipients that
 * already got it.
 */
export class CloudflareProvider extends BaseProvider {
  readonly name = "cloudflare" as const;
  readonly maxMessageBytes = 5 * 1024 * 1024;
  readonly maxRecipients = 50;

  constructor(private readonly config: CloudflareConfig) {
    super();
  }

  protected async deliver(message: OutboundMessage): Promise<SendResult> {
    const binding = this.config.binding;
    if (!binding) {
      throw new SendError(
        "Cloudflare Email Sending needs a Workers Paid plan and a `send_email` binding named EMAIL; " +
          "it is not available here. Use MAIL_PROVIDER=mailgun on Workers Free.",
        false,
        "notConfigured",
      );
    }
    let providerMessageId: string | undefined;
    let sent = 0;
    for (const rcpt of message.rcptTo) {
      const raw = message.raw;
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(raw);
          controller.close();
        },
      });
      try {
        const result = (await binding.send(new EmailMessage(message.mailFrom, rcpt, stream))) as
          | { messageId?: unknown }
          | undefined;
        if (providerMessageId === undefined && typeof result?.messageId === "string") {
          providerMessageId = result.messageId;
        }
        sent++;
      } catch (err) {
        const mapped = mapCloudflareError(err);
        if (sent === 0) throw mapped;
        throw new SendError(
          `Delivered to ${sent} of ${message.rcptTo.length} recipients before failing: ${mapped.message}`,
          false,
          "partial",
        );
      }
    }
    return providerMessageId ? { providerMessageId } : {};
  }
}
