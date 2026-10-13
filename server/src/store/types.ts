/** Types shared by the account DO, the ingest handler and (later) the JMAP layer. */

/** JMAP EmailAddress (RFC 8621 §4.1.2.3). Address groups are flattened into the list. */
export type EmailAddress = { name: string | null; email: string };

/** Subset of RFC 8621 mailbox roles this store creates and ingest can target. */
export type MailboxRole = "inbox" | "drafts" | "sent" | "junk" | "trash" | "archive";

/**
 * JMAP EmailBodyPart (RFC 8621 §4.1.4), as produced by the deferred parse.
 *
 * The tree is *synthesized* from postal-mime's flat output (it does not expose the original
 * MIME tree), so it is normalized: `multipart/mixed` [ `multipart/alternative` [text, html],
 * ...attachments ] with the multipart levels dropped when they would have one child.
 *
 * Leaf parts carry a `partId` and a `blobId` (see `partBlobId` in ./blob.ts):
 *   partId "1" = text/plain body, "2" = text/html body, "3".."N" = attachments in order.
 */
export type BodyPart = {
  /** null for multipart containers. */
  partId: string | null;
  /** Download blob of the decoded part content (R2 `${accountId}/${blobId}`); null for multipart. */
  blobId: string | null;
  /** Decoded size in octets; 0 for multipart. */
  size: number;
  type: string;
  charset: string | null;
  name: string | null;
  disposition: string | null;
  /** Content-ID without angle brackets. */
  cid: string | null;
  subParts: BodyPart[] | null;
};

export type IngestInput = {
  accountId: string;
  /** Opaque id of the raw message in R2 (`${accountId}/${blobId}`). Ingest is idempotent per blobId. */
  blobId: string;
  size: number;
  /** ms since epoch. */
  receivedAt: number;
  headers: {
    /** Without angle brackets. */
    messageId: string | null;
    inReplyTo: string[];
    references: string[];
    subject: string | null;
    /** Date header in ms since epoch, or null. */
    sentAt: number | null;
    from: EmailAddress[];
    sender: EmailAddress[];
    to: EmailAddress[];
    cc: EmailAddress[];
    replyTo: EmailAddress[];
  };
  envelope: { mailFrom: string; rcptTo: string };
  mailboxRole: "inbox";
};

export type IngestResult = { emailId: string; threadId: string };

/** JMAP state strings (RFC 8620 §5.1) for the types this store tracks. */
export type AccountState = {
  Email: string;
  Mailbox: string;
  Thread: string;
  /** Changes only when a new message is delivered (RFC 8621 §1.5). */
  EmailDelivery: string;
};

/** WebSocket push payload, a JMAP StateChange object (RFC 8620 §7.1) for one account. */
export type StateChangeMessage = {
  "@type": "StateChange";
  changed: Record<string, AccountState>;
};

/** The storage seam: a self-hosted adapter (SQLite file per account) can implement this too. */
export interface AccountStore {
  init(accountId: string): void;
  ingest(input: IngestInput): Promise<IngestResult>;
  getState(): AccountState;
  deleteAll(): Promise<string[]>;
}
