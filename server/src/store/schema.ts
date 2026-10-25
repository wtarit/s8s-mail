import { sql } from "drizzle-orm";
import {
  index,
  integer,
  primaryKey,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";
import type { BodyPart, EmailAddress } from "./types";

/**
 * Account DO schema (per-account SQLite), modelled on JMAP Mail (RFC 8620 + RFC 8621).
 * Comments tag columns that are JMAP properties of the same (camelCase) name.
 *
 * Hand-written SQL that Drizzle cannot express (the FTS5 table and the change-log
 * triggers) lives in `drizzle/do/0001_*.sql`; keep it in sync when columns change.
 * Regenerate with `pnpm db:generate:do`.
 */

/** Key/value store: `accountId` (DOs do not know their own name), future counters. */
export const meta = sqliteTable("meta", {
  key: text("key").primaryKey(),
  value: text("value").notNull(),
  updatedAt: integer("updated_at").notNull(),
});

/** JMAP Mailbox (RFC 8621 §2). Counts (totalEmails, ...) are computed by query, not stored. */
export const mailbox = sqliteTable(
  "mailbox",
  {
    id: text("id").primaryKey(), // id
    name: text("name").notNull(), // name
    parentId: text("parent_id"), // parentId (null = top level)
    role: text("role"), // role: inbox, drafts, sent, junk, trash, archive, ... (null = none)
    sortOrder: integer("sort_order").notNull().default(0), // sortOrder
    isSubscribed: integer("is_subscribed", { mode: "boolean" }).notNull().default(true), // isSubscribed
  },
  (t) => [
    // At most one mailbox per role (RFC 8621 §2: "MUST be unique for the account").
    uniqueIndex("mailbox_role_uq")
      .on(t.role)
      .where(sql`role is not null`),
    index("mailbox_parent_idx").on(t.parentId),
  ],
);

/**
 * JMAP Email (RFC 8621 §4). Header-derived columns are filled at ingest by `email()`;
 * the body-derived columns (preview, has_attachment, body_structure, text_body,
 * html_body, attachments) are NULL/empty until the deferred parse (alarm) completes.
 * `mailboxIds` -> `email_mailbox`, `keywords` -> `email_keyword`.
 */
export const email = sqliteTable(
  "email",
  {
    id: text("id").primaryKey(), // id
    /** Raw RFC 5322 message in R2 at `${accountId}/${blobId}`. */
    blobId: text("blob_id").notNull(), // blobId
    threadId: text("thread_id").notNull(), // threadId
    size: integer("size").notNull(), // size (octets of the raw message)
    receivedAt: integer("received_at").notNull(), // receivedAt (ms since epoch, UTC)
    sentAt: integer("sent_at"), // sentAt (Date header, ms since epoch; null if absent/invalid)
    /** First Message-ID without angle brackets; JMAP `messageId` is `[messageId]`. */
    messageId: text("message_id"), // messageId
    inReplyTo: text("in_reply_to", { mode: "json" }).$type<string[]>(), // inReplyTo
    references: text("references", { mode: "json" }).$type<string[]>(), // references
    subject: text("subject"), // subject
    from: text("from", { mode: "json" }).$type<EmailAddress[]>(), // from
    sender: text("sender", { mode: "json" }).$type<EmailAddress[]>(), // sender
    to: text("to", { mode: "json" }).$type<EmailAddress[]>(), // to
    cc: text("cc", { mode: "json" }).$type<EmailAddress[]>(), // cc
    bcc: text("bcc", { mode: "json" }).$type<EmailAddress[]>(), // bcc
    replyTo: text("reply_to", { mode: "json" }).$type<EmailAddress[]>(), // replyTo
    preview: text("preview").notNull().default(""), // preview (<= 256 chars; "" until parsed)
    hasAttachment: integer("has_attachment", { mode: "boolean" }).notNull().default(false), // hasAttachment
    bodyStructure: text("body_structure", { mode: "json" }).$type<BodyPart>(), // bodyStructure
    textBody: text("text_body", { mode: "json" }).$type<BodyPart[]>(), // textBody
    htmlBody: text("html_body", { mode: "json" }).$type<BodyPart[]>(), // htmlBody
    attachments: text("attachments", { mode: "json" }).$type<BodyPart[]>(), // attachments
    /** pending -> parsed | failed. See AccountDO.alarm(). */
    parseState: text("parse_state", { enum: ["pending", "parsed", "failed"] })
      .notNull()
      .default("pending"),
    parseAttempts: integer("parse_attempts").notNull().default(0),
    parseError: text("parse_error"),
  },
  (t) => [
    uniqueIndex("email_blob_uq").on(t.blobId),
    index("email_thread_idx").on(t.threadId),
    index("email_received_idx").on(t.receivedAt),
    index("email_message_id_idx").on(t.messageId),
    index("email_parse_state_idx").on(t.parseState),
  ],
);

/** Email.mailboxIds: one row per (email, mailbox). */
export const emailMailbox = sqliteTable(
  "email_mailbox",
  {
    emailId: text("email_id")
      .notNull()
      .references(() => email.id, { onDelete: "cascade" }),
    mailboxId: text("mailbox_id")
      .notNull()
      .references(() => mailbox.id, { onDelete: "cascade" }),
  },
  (t) => [
    primaryKey({ columns: [t.emailId, t.mailboxId] }),
    index("email_mailbox_mb_idx").on(t.mailboxId, t.emailId),
  ],
);

/** Email.keywords: one row per (email, keyword); keywords are stored lowercase ($seen, $flagged, ...). */
export const emailKeyword = sqliteTable(
  "email_keyword",
  {
    emailId: text("email_id")
      .notNull()
      .references(() => email.id, { onDelete: "cascade" }),
    keyword: text("keyword").notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.emailId, t.keyword] }),
    index("email_keyword_kw_idx").on(t.keyword, t.emailId),
  ],
);

/**
 * Normalized Message-ID (lowercase, no angle brackets) -> thread. Both an email's own
 * Message-ID and every id it references are recorded, so replies, and replies that arrive
 * before the original, join the same thread.
 */
export const threadRef = sqliteTable(
  "thread_ref",
  {
    messageId: text("message_id").primaryKey(),
    threadId: text("thread_id").notNull(),
  },
  (t) => [index("thread_ref_thread_idx").on(t.threadId)],
);

/**
 * Change log for `Foo/changes` (RFC 8620 §5.2), maintained by SQLite triggers on email,
 * mailbox, email_mailbox and email_keyword (see drizzle/do/0001_*.sql). A JMAP state
 * string for a type is `MAX(seq)` over that type's rows ("0" when empty).
 * `EmailDelivery` rows are written by `ingest()` itself (new-mail push state, RFC 8621 §1.5).
 */
export const changeLog = sqliteTable(
  "change_log",
  {
    seq: integer("seq").primaryKey({ autoIncrement: true }),
    type: text("type", {
      enum: ["Email", "Mailbox", "Thread", "EmailDelivery", "EmailSubmission", "Identity"],
    }).notNull(),
    objectId: text("object_id").notNull(),
    kind: text("kind", { enum: ["created", "updated", "destroyed"] }).notNull(),
    /**
     * 1 for Mailbox "updated" entries that only moved the counts (an email joined/left the
     * mailbox, or $seen/$draft changed); Mailbox/changes uses it for `updatedProperties`.
     */
    countsOnly: integer("counts_only").notNull().default(0),
  },
  (t) => [index("change_log_type_seq_idx").on(t.type, t.seq)],
);

/**
 * Per-address Identity settings (name, signatures, reply-to, bcc). The Identity objects
 * themselves are derived from the D1 `address` rows (primary + aliases); only what the user
 * edits is stored here, keyed by the lowercased address. Triggers log type `Identity`.
 */
export const identitySetting = sqliteTable("identity_setting", {
  address: text("address").primaryKey(),
  name: text("name"),
  replyTo: text("reply_to", { mode: "json" }).$type<EmailAddress[] | null>(),
  bcc: text("bcc", { mode: "json" }).$type<EmailAddress[] | null>(),
  textSignature: text("text_signature"),
  htmlSignature: text("html_signature"),
  updatedAt: integer("updated_at").notNull(),
});

export type DeliveryStatus = {
  smtpReply: string;
  delivered: "queued" | "yes" | "no" | "unknown";
  displayed: "unknown" | "yes";
};

/**
 * JMAP EmailSubmission (RFC 8621 §7). V1 sends synchronously through the outbound provider,
 * so every row is `final`; there is no queue, retry or undo. `emailId` has no foreign key:
 * a submission outlives the Email it was made from (the Sent copy may be deleted).
 */
export const emailSubmission = sqliteTable(
  "email_submission",
  {
    id: text("id").primaryKey(), // id
    identityId: text("identity_id").notNull(), // identityId
    emailId: text("email_id").notNull(), // emailId
    threadId: text("thread_id").notNull(), // threadId
    envelopeMailFrom: text("envelope_mail_from").notNull(), // envelope.mailFrom.email
    envelopeRcptTo: text("envelope_rcpt_to", { mode: "json" }).$type<string[]>().notNull(), // envelope.rcptTo[].email
    sendAt: integer("send_at").notNull(), // sendAt (ms since epoch)
    undoStatus: text("undo_status", { enum: ["pending", "final", "canceled"] })
      .notNull()
      .default("final"), // undoStatus
    deliveryStatus: text("delivery_status", { mode: "json" }).$type<Record<
      string,
      DeliveryStatus
    > | null>(), // deliveryStatus
    providerMessageId: text("provider_message_id"),
  },
  (t) => [index("email_submission_email_idx").on(t.emailId)],
);
