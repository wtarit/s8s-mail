import { asc, eq } from "drizzle-orm";
import { blobKey, MAX_PART_OBJECTS, partBlobId } from "./blob";
import type { AccountDb } from "./email-insert";
import { parseMessage } from "./parse";
import * as schema from "./schema";
import type { EmailAddress } from "./types";

const { email } = schema;

/** An email is marked `failed` once its parse has been attempted this many times. */
export const MAX_PARSE_ATTEMPTS = 3;

function addressText(list: EmailAddress[] | null | undefined): string {
  return (list ?? []).map((a) => (a.name ? `${a.name} ${a.email}` : a.email)).join(" ");
}

/** What the deferred parse needs from the Durable Object that owns the account. */
export interface ParseHost {
  db: AccountDb;
  storage: DurableObjectStorage;
  blobs: R2Bucket;
  accountId(): string | null;
  /** Pushes a StateChange to subscribers. */
  broadcast(): void;
}

/** Arms the parse alarm if an email is waiting for its body to be parsed. */
export async function scheduleParseIfPending(
  db: AccountDb,
  storage: DurableObjectStorage,
  delayMs = 0,
): Promise<void> {
  const pending = db
    .select({ id: email.id })
    .from(email)
    .where(eq(email.parseState, "pending"))
    .limit(1)
    .get();
  if (!pending) return;
  const current = await storage.getAlarm();
  if (current === null) await storage.setAlarm(Date.now() + delayMs);
}

/**
 * Parses ONE pending email per invocation (10 ms CPU on Free). The attempt counter is
 * incremented and flushed to disk before any work: an invocation killed for exceeding
 * the CPU limit never reaches its own error handling, so on the next alarm the counter
 * is what marks the message `failed` after MAX_PARSE_ATTEMPTS tries.
 */
export async function parseNextPending(host: ParseHost): Promise<void> {
  const { db, storage } = host;
  const row = db
    .select()
    .from(email)
    .where(eq(email.parseState, "pending"))
    .orderBy(asc(email.receivedAt))
    .limit(1)
    .get();
  if (!row) return;

  if (row.parseAttempts >= MAX_PARSE_ATTEMPTS) {
    markFailed(db, row.id, row.parseError ?? "parse attempts exhausted (CPU limit?)");
    await scheduleParseIfPending(db, storage);
    return;
  }
  const attempt = row.parseAttempts + 1;
  db.update(email).set({ parseAttempts: attempt }).where(eq(email.id, row.id)).run();
  await storage.sync();

  let failed = false;
  try {
    const accountId = host.accountId();
    if (!accountId) throw new Error("accountId not set");
    const obj = await host.blobs.get(blobKey(accountId, row.blobId));
    if (!obj) throw new Error("raw message missing in R2");
    const parsed = await parseMessage(obj.body, row.blobId);

    // Materialize decoded parts so bodies/attachments are served without re-parsing.
    await Promise.all(
      parsed.parts.slice(0, MAX_PART_OBJECTS).map((p) =>
        host.blobs.put(blobKey(accountId, partBlobId(row.blobId, p.partId)), p.content, {
          httpMetadata: {
            contentType: typeof p.content === "string" ? `${p.type}; charset=utf-8` : p.type,
          },
        }),
      ),
    );

    storage.transactionSync(() => {
      db.update(email)
        .set({
          preview: parsed.preview,
          hasAttachment: parsed.hasAttachment,
          bodyStructure: parsed.bodyStructure,
          textBody: parsed.textBody,
          htmlBody: parsed.htmlBody,
          attachments: parsed.attachments,
          parseState: "parsed",
          parseError: null,
        })
        .where(eq(email.id, row.id))
        .run(); // trigger logs Email updated
      const s = storage.sql;
      const rowid = s
        .exec<{ rowid: number }>("SELECT rowid FROM email WHERE id = ?", row.id)
        .one().rowid;
      s.exec("DELETE FROM email_fts WHERE rowid = ?", rowid);
      s.exec(
        "INSERT INTO email_fts(rowid, subject, sender, recipients, body) VALUES (?, ?, ?, ?, ?)",
        rowid,
        row.subject ?? "",
        addressText(row.from),
        `${addressText(row.to)} ${addressText(row.cc)}`.trim(),
        parsed.ftsBody,
      );
    });
    host.broadcast();
  } catch (err) {
    failed = true;
    const message = err instanceof Error ? err.message : String(err);
    if (attempt >= MAX_PARSE_ATTEMPTS) markFailed(db, row.id, message);
    else db.update(email).set({ parseError: message }).where(eq(email.id, row.id)).run();
  }
  await scheduleParseIfPending(db, storage, failed ? 2000 * attempt : 0);
}

function markFailed(db: AccountDb, emailId: string, error: string): void {
  db.update(email)
    .set({ parseState: "failed", parseError: error })
    .where(eq(email.id, emailId))
    .run();
}
