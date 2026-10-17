/**
 * Input shapes for the MIME builder: the JMAP `Email/set` create object (RFC 8621 §4.6)
 * as sent by webmail clients. Fields are loosely typed (nullable/optional) because the
 * JMAP layer passes client input through after shape validation.
 */

export interface EmailAddress {
  name?: string | null;
  email: string;
}

export interface EmailBodyPartRef {
  partId: string;
  /** Content type of the part; defaults to text/plain (textBody) or text/html (htmlBody). */
  type?: string | null;
}

export interface EmailAttachmentInput {
  blobId: string;
  /** Content type, e.g. `image/png`. */
  type: string;
  name?: string | null;
  /** `attachment` (default) or `inline`. */
  disposition?: string | null;
  /** Content-ID without angle brackets; used by `inline` parts referenced from the HTML. */
  cid?: string | null;
}

export type EmailHeaderInput = { name: string; value: string }[] | Record<string, string>;

export interface EmailCreate {
  from: EmailAddress[];
  to?: EmailAddress[] | null;
  cc?: EmailAddress[] | null;
  bcc?: EmailAddress[] | null;
  replyTo?: EmailAddress[] | null;
  sender?: EmailAddress[] | null;
  subject?: string | null;
  /** ISO 8601 date-time; defaults to `options.now`. */
  sentAt?: string | null;
  /** Message-ID(s) without angle brackets; generated when absent. */
  messageId?: string | string[] | null;
  inReplyTo?: string | string[] | null;
  references?: string | string[] | null;
  bodyValues?: Record<string, { value: string }> | null;
  textBody?: EmailBodyPartRef[] | null;
  htmlBody?: EmailBodyPartRef[] | null;
  attachments?: EmailAttachmentInput[] | null;
  /** Extra headers (raw name/value pairs). Headers the builder generates itself are ignored. */
  headers?: EmailHeaderInput | null;
}

export interface BuildMimeOptions {
  /** Resolves a blobId to its bytes, or null when unknown. */
  fetchBlob(blobId: string): Promise<Uint8Array | null>;
  /** Domain used for generated Message-IDs. */
  messageIdDomain: string;
  /** Emit the Bcc header (for the Sent copy). Strip it with `removeBccHeader` before sending. */
  includeBcc: boolean;
  now?: Date;
}

export interface BuiltMime {
  raw: Uint8Array;
  /** Message-ID without angle brackets (JMAP style). */
  messageId: string;
  size: number;
}

/** An attachment blob that `fetchBlob` could not resolve. Map to JMAP `blobNotFound`. */
export class BlobNotFoundError extends Error {
  constructor(readonly blobId: string) {
    super(`Blob not found: ${blobId}`);
    this.name = "BlobNotFoundError";
  }
}

/** The create object cannot be turned into a message. Map to JMAP `invalidProperties`. */
export class MimeBuildError extends Error {
  readonly code = "invalidProperties";
  constructor(
    message: string,
    /** The offending JMAP property, e.g. `from` or `bodyValues`. */
    readonly property?: string,
  ) {
    super(message);
    this.name = "MimeBuildError";
  }
}
