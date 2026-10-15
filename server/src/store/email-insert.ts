import { eq, inArray } from "drizzle-orm";
import type { DrizzleSqliteDODatabase } from "drizzle-orm/durable-sqlite";
import { newId } from "./blob";
import * as schema from "./schema";
import { threadCandidates } from "./threading";
import type { EmailAddress, IngestInput, IngestResult, MailboxRole } from "./types";

const { mailbox, email, emailMailbox, emailKeyword, threadRef, changeLog } = schema;

export type AccountDb = DrizzleSqliteDODatabase<typeof schema>;

/**
 * Inserts a header-only email row with its thread, mailbox membership and keywords (the
 * caller wraps this in a transaction). Idempotent per blobId.
 */
export function insertEmail(
  db: AccountDb,
  input: Pick<IngestInput, "blobId" | "size" | "receivedAt" | "headers">,
  target: { role: MailboxRole } | { mailboxIds: string[]; keywords: string[]; bcc: EmailAddress[] },
): IngestResult & { created: boolean } {
  const existing = db
    .select({ emailId: email.id, threadId: email.threadId })
    .from(email)
    .where(eq(email.blobId, input.blobId))
    .get();
  if (existing) return { ...existing, created: false };

  let boxIds: string[];
  if ("role" in target) {
    const box = db
      .select({ id: mailbox.id })
      .from(mailbox)
      .where(eq(mailbox.role, target.role))
      .get();
    if (!box) throw new Error(`No mailbox with role ${target.role}`);
    boxIds = [box.id];
  } else {
    boxIds = target.mailboxIds;
  }

  const h = input.headers;
  const candidates = threadCandidates(h.messageId, h.inReplyTo, h.references);
  let threadId: string | undefined;
  if (candidates.length > 0) {
    const known = new Map(
      db
        .select()
        .from(threadRef)
        .where(inArray(threadRef.messageId, candidates))
        .all()
        .map((r) => [r.messageId, r.threadId]),
    );
    threadId = candidates.map((c) => known.get(c)).find((t) => t !== undefined);
  }
  threadId ??= newId("t");
  if (candidates.length > 0) {
    db.insert(threadRef)
      .values(candidates.map((messageId) => ({ messageId, threadId })))
      .onConflictDoNothing()
      .run();
  }

  const emailId = newId("e");
  // The triggers in drizzle/do/0001_*.sql log Email/Thread created here and Mailbox/Email
  // updated for the membership insert below.
  db.insert(email)
    .values({
      id: emailId,
      blobId: input.blobId,
      threadId,
      size: input.size,
      receivedAt: input.receivedAt,
      sentAt: h.sentAt,
      messageId: h.messageId,
      inReplyTo: h.inReplyTo,
      references: h.references,
      subject: h.subject,
      from: h.from,
      sender: h.sender,
      to: h.to,
      cc: h.cc,
      bcc: "bcc" in target ? target.bcc : [],
      replyTo: h.replyTo,
    })
    .run();
  db.insert(emailMailbox)
    .values(boxIds.map((mailboxId) => ({ emailId, mailboxId })))
    .run();
  if ("keywords" in target && target.keywords.length > 0) {
    db.insert(emailKeyword)
      .values(target.keywords.map((keyword) => ({ emailId, keyword })))
      .run();
  }
  if ("role" in target) {
    db.insert(changeLog)
      .values({ type: "EmailDelivery", objectId: emailId, kind: "created" })
      .run();
  }
  return { emailId, threadId, created: true };
}
