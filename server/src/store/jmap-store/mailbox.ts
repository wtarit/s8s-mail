import type {
  MailboxGetResult,
  MailboxQueryParams,
  MailboxQueryResult,
  MailboxRow,
} from "../jmap-types";
import { chunkIds, type StoreSql } from "./sql";

export function mailboxRows(sql: StoreSql, ids: string[] | null): MailboxRow[] {
  const unreadPred =
    "NOT EXISTS (SELECT 1 FROM email_keyword k WHERE k.email_id = %ID% AND k.keyword IN ('$seen', '$draft'))";
  const rows = sql.all(
    `SELECT mb.id, mb.name, mb.parent_id, mb.role, mb.sort_order, mb.is_subscribed,
      (SELECT count(*) FROM email_mailbox em WHERE em.mailbox_id = mb.id) AS total_emails,
      (SELECT count(*) FROM email_mailbox em WHERE em.mailbox_id = mb.id AND ${unreadPred.replace("%ID%", "em.email_id")}) AS unread_emails,
      (SELECT count(DISTINCT e.thread_id) FROM email_mailbox em JOIN email e ON e.id = em.email_id WHERE em.mailbox_id = mb.id) AS total_threads,
      (SELECT count(DISTINCT e.thread_id) FROM email_mailbox em JOIN email e ON e.id = em.email_id
        WHERE em.mailbox_id = mb.id
          AND EXISTS (SELECT 1 FROM email u WHERE u.thread_id = e.thread_id AND ${unreadPred.replace("%ID%", "u.id")})) AS unread_threads
     FROM mailbox mb
     WHERE (?1 IS NULL OR mb.id IN (SELECT value FROM json_each(?1)))
     ORDER BY mb.sort_order, mb.name, mb.id`,
    ids ? chunkIds(ids) : null,
  );
  return rows.map((r) => ({
    id: r.id as string,
    name: r.name as string,
    parentId: (r.parent_id as string | null) ?? null,
    role: (r.role as string | null) ?? null,
    sortOrder: r.sort_order as number,
    isSubscribed: r.is_subscribed === 1,
    totalEmails: r.total_emails as number,
    unreadEmails: r.unread_emails as number,
    totalThreads: r.total_threads as number,
    unreadThreads: r.unread_threads as number,
  }));
}

export function mailboxGet(sql: StoreSql, ids: string[] | null): MailboxGetResult {
  const list = mailboxRows(sql, ids);
  const found = new Set(list.map((m) => m.id));
  return {
    state: sql.state("Mailbox"),
    list,
    notFound: ids ? ids.filter((i) => !found.has(i)) : [],
  };
}

export function mailboxQuery(sql: StoreSql, p: MailboxQueryParams): MailboxQueryResult {
  let rows = mailboxRows(sql, null);
  const f = p.filter;
  if (f.parentId !== undefined) rows = rows.filter((m) => m.parentId === f.parentId);
  if (f.name !== undefined) {
    const needle = f.name.toLowerCase();
    rows = rows.filter((m) => m.name.toLowerCase().includes(needle));
  }
  if (f.role !== undefined) rows = rows.filter((m) => m.role === f.role);
  if (f.hasAnyRole !== undefined) rows = rows.filter((m) => (m.role !== null) === f.hasAnyRole);
  if (f.isSubscribed !== undefined) rows = rows.filter((m) => m.isSubscribed === f.isSubscribed);
  const sorts =
    p.sort.length > 0 ? p.sort : [{ property: "sortOrder" as const, isAscending: true }];
  rows.sort((a, b) => {
    for (const s of sorts) {
      const c =
        s.property === "name"
          ? a.name.toLowerCase().localeCompare(b.name.toLowerCase())
          : a.sortOrder - b.sortOrder;
      if (c !== 0) return s.isAscending ? c : -c;
    }
    return a.id < b.id ? -1 : 1;
  });
  const total = rows.length;
  const position = Math.min(p.position, total);
  const page = rows.slice(position, p.limit === null ? undefined : position + p.limit);
  return {
    queryState: sql.state("Mailbox"),
    ids: page.map((m) => m.id),
    total,
    position,
  };
}

export function mailboxIdsExist(sql: StoreSql, ids: string[]): boolean {
  const n = sql.first<{ n: number }>(
    "SELECT count(*) AS n FROM mailbox WHERE id IN (SELECT value FROM json_each(?))",
    chunkIds(ids),
  )?.n;
  return n === new Set(ids).size;
}
