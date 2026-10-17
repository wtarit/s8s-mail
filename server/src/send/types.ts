/**
 * Outbound mail provider contract. One provider is active per deployment
 * (env.MAIL_PROVIDER). JMAP submission and system mail (magic links,
 * invites) both go through it; neither knows which provider is behind it.
 */

export interface OutboundMessage {
  /** Envelope MAIL FROM (bare addr-spec). */
  mailFrom: string;
  /** Envelope RCPT TO (bare addr-specs, Bcc included). */
  rcptTo: string[];
  /** Complete RFC 5322 message, Bcc header already removed. */
  raw: Uint8Array;
}

export interface SendResult {
  /** Provider's id for the message, when it returns one. */
  providerMessageId?: string;
}

export class SendError extends Error {
  constructor(
    message: string,
    /** true when retrying later may succeed (429, 5xx, network). */
    readonly retryable: boolean,
    readonly code?: string,
  ) {
    super(message);
    this.name = "SendError";
  }
}

export interface SendProvider {
  readonly name: "mailgun";
  /** Largest raw message (bytes) the provider accepts. */
  readonly maxMessageBytes: number;
  /** Largest recipient count per message. */
  readonly maxRecipients: number;
  send(message: OutboundMessage): Promise<SendResult>;
}

/** A simple text/html message from the system (magic link, invite). */
export interface SystemMail {
  to: string;
  subject: string;
  text: string;
  html?: string;
}
