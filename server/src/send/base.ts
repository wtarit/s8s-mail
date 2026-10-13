import type { OutboundMessage, SendProvider, SendResult } from "./types";
import { SendError } from "./types";

/**
 * Bindings and secrets the send module reads that are not (yet) in the generated `Env`.
 * `MAILGUN_API` is a secret (`wrangler secret put MAILGUN_API`); `EMAIL` is an optional
 * `send_email` binding (Workers Paid only).
 */
export interface SendEnv {
  MAILGUN_API?: string;
  EMAIL?: SendEmail;
}

/** Common size/recipient enforcement; subclasses implement `deliver`. */
export abstract class BaseProvider implements SendProvider {
  abstract readonly name: SendProvider["name"];
  abstract readonly maxMessageBytes: number;
  abstract readonly maxRecipients: number;

  async send(message: OutboundMessage): Promise<SendResult> {
    if (message.rcptTo.length === 0) {
      throw new SendError("Message has no recipients", false, "noRecipients");
    }
    if (message.rcptTo.length > this.maxRecipients) {
      throw new SendError(
        `Too many recipients: ${message.rcptTo.length} (${this.name} allows ${this.maxRecipients})`,
        false,
        "tooManyRecipients",
      );
    }
    if (message.raw.byteLength > this.maxMessageBytes) {
      throw new SendError(
        `Message is ${message.raw.byteLength} bytes; ${this.name} allows ${this.maxMessageBytes}`,
        false,
        "tooLarge",
      );
    }
    return this.deliver(message);
  }

  protected abstract deliver(message: OutboundMessage): Promise<SendResult>;
}
