import type { MailboxRow, MailboxSetParams, MailboxSetResult, StoreError } from "../jmap-types";
import { deleteEmails } from "./email-write";
import { mailboxRows } from "./mailbox";
import { createMailbox, updateMailbox } from "./mailbox-write";
import type { StoreSql } from "./sql";

const SYSTEM_ROLES = new Set(["inbox", "drafts", "sent", "junk", "trash", "archive"]);

/** Caller wraps this in a transaction. Returns blob ids of removed emails. */
export function mailboxSet(sql: StoreSql, p: MailboxSetParams): MailboxSetResult {
  const oldState = sql.state("Mailbox");
  if (p.ifInState !== null && p.ifInState !== oldState) {
    return { ok: false, error: { type: "stateMismatch" } };
  }
  const created: Record<string, MailboxRow> = {};
  const notCreated: Record<string, StoreError> = {};
  const updated: string[] = [];
  const notUpdated: Record<string, StoreError> = {};
  const destroyed: string[] = [];
  const notDestroyed: Record<string, StoreError> = {};
  const removedBlobIds: string[] = [];
  const createdIds = new Map<string, string>();

  // Creates: multi-pass so a child may reference a parent created in the same call.
  let pending = [...p.create];
  while (pending.length > 0) {
    const next: typeof pending = [];
    for (const c of pending) {
      let parentId = c.parentId;
      if (parentId?.startsWith("#")) {
        const mapped = createdIds.get(parentId.slice(1));
        if (mapped) parentId = mapped;
        else if (
          p.create.some((x) => x.key === parentId!.slice(1)) &&
          !notCreated[parentId.slice(1)]
        ) {
          next.push(c);
          continue;
        }
      }
      const err = createMailbox(sql, c, parentId);
      if (typeof err === "string") {
        createdIds.set(c.key, err);
      } else {
        notCreated[c.key] = err;
      }
    }
    if (next.length === pending.length) {
      for (const c of next) {
        notCreated[c.key] = { type: "invalidProperties", properties: ["parentId"] };
      }
      break;
    }
    pending = next;
  }
  if (createdIds.size > 0) {
    const rows = mailboxRows(sql, [...createdIds.values()]);
    for (const [key, id] of createdIds) {
      const row = rows.find((r) => r.id === id);
      if (row) created[key] = row;
    }
  }

  for (const u of p.update) {
    const err = updateMailbox(sql, u);
    if (err) notUpdated[u.id] = err;
    else updated.push(u.id);
  }

  for (const id of p.destroy) {
    const mb = sql.first<{ id: string; role: string | null }>(
      "SELECT id, role FROM mailbox WHERE id = ?",
      id,
    );
    if (!mb) {
      notDestroyed[id] = { type: "notFound" };
      continue;
    }
    if (mb.role && SYSTEM_ROLES.has(mb.role)) {
      notDestroyed[id] = {
        type: "forbidden",
        description: `The ${mb.role} mailbox cannot be destroyed`,
      };
      continue;
    }
    if (sql.first("SELECT 1 AS x FROM mailbox WHERE parent_id = ?", id)) {
      notDestroyed[id] = { type: "mailboxHasChild" };
      continue;
    }
    const members = sql.all<{ email_id: string }>(
      "SELECT email_id FROM email_mailbox WHERE mailbox_id = ?",
      id,
    );
    if (members.length > 0 && !p.onDestroyRemoveEmails) {
      notDestroyed[id] = { type: "mailboxHasEmail" };
      continue;
    }
    if (members.length > 0) {
      // Emails only in this mailbox are destroyed; others just leave it.
      const only = sql
        .all<{ email_id: string }>(
          `SELECT em.email_id FROM email_mailbox em WHERE em.mailbox_id = ?
         AND NOT EXISTS (SELECT 1 FROM email_mailbox o WHERE o.email_id = em.email_id AND o.mailbox_id <> em.mailbox_id)`,
          id,
        )
        .map((r) => r.email_id);
      const { blobIds } = deleteEmails(sql, only);
      removedBlobIds.push(...blobIds);
      sql.run("DELETE FROM email_mailbox WHERE mailbox_id = ?", id);
    }
    sql.run("DELETE FROM mailbox WHERE id = ?", id);
    destroyed.push(id);
  }

  return {
    ok: true,
    oldState,
    newState: sql.state("Mailbox"),
    created,
    notCreated,
    updated,
    notUpdated,
    destroyed,
    notDestroyed,
    removedBlobIds,
  };
}
