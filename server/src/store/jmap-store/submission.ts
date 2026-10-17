import { newId } from "../blob";
import type { SqlValue } from "../jmap-filter";
import type {
  IdentitySettingRow,
  IdentitySettingUpdate,
  SubmissionCreateInput,
  SubmissionQueryParams,
  SubmissionRow,
} from "../jmap-types";
import type { EmailAddress } from "../types";
import { chunkIds, json, type Row, type StoreSql } from "./sql";

export function identitySettings(sql: StoreSql): IdentitySettingRow[] {
  return sql
    .all(
      "SELECT address, name, reply_to, bcc, text_signature, html_signature FROM identity_setting",
    )
    .map((r) => ({
      address: r.address as string,
      name: (r.name as string | null) ?? null,
      replyTo: json<EmailAddress[]>(r.reply_to),
      bcc: json<EmailAddress[]>(r.bcc),
      textSignature: (r.text_signature as string | null) ?? null,
      htmlSignature: (r.html_signature as string | null) ?? null,
    }));
}

export function identitySettingsSet(
  sql: StoreSql,
  address: string,
  update: IdentitySettingUpdate,
): void {
  const cur = identitySettings(sql).find((s) => s.address === address);
  const next = {
    name: update.name !== undefined ? update.name : (cur?.name ?? null),
    replyTo: update.replyTo !== undefined ? update.replyTo : (cur?.replyTo ?? null),
    bcc: update.bcc !== undefined ? update.bcc : (cur?.bcc ?? null),
    textSignature:
      update.textSignature !== undefined ? update.textSignature : (cur?.textSignature ?? null),
    htmlSignature:
      update.htmlSignature !== undefined ? update.htmlSignature : (cur?.htmlSignature ?? null),
  };
  sql.run(
    `INSERT INTO identity_setting (address, name, reply_to, bcc, text_signature, html_signature, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(address) DO UPDATE SET name = excluded.name, reply_to = excluded.reply_to,
       bcc = excluded.bcc, text_signature = excluded.text_signature,
       html_signature = excluded.html_signature, updated_at = excluded.updated_at`,
    address,
    next.name,
    next.replyTo ? JSON.stringify(next.replyTo) : null,
    next.bcc ? JSON.stringify(next.bcc) : null,
    next.textSignature,
    next.htmlSignature,
    Date.now(),
  );
}

// --- EmailSubmission -----------------------------------------------------------------

export function submissionFromRow(sql: StoreSql, r: Row): SubmissionRow {
  return {
    id: r.id as string,
    identityId: r.identity_id as string,
    emailId: r.email_id as string,
    threadId: r.thread_id as string,
    envelopeMailFrom: r.envelope_mail_from as string,
    envelopeRcptTo: json<string[]>(r.envelope_rcpt_to) ?? [],
    sendAt: r.send_at as number,
    undoStatus: r.undo_status as SubmissionRow["undoStatus"],
    deliveryStatus: json<SubmissionRow["deliveryStatus"]>(r.delivery_status),
  };
}

export function submissionCreate(sql: StoreSql, input: SubmissionCreateInput): SubmissionRow {
  const id = newId("e").replace(/^e/, "s");
  sql.run(
    `INSERT INTO email_submission (id, identity_id, email_id, thread_id, envelope_mail_from,
       envelope_rcpt_to, send_at, undo_status, delivery_status, provider_message_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    id,
    input.identityId,
    input.emailId,
    input.threadId,
    input.envelopeMailFrom,
    JSON.stringify(input.envelopeRcptTo),
    input.sendAt,
    input.undoStatus,
    input.deliveryStatus ? JSON.stringify(input.deliveryStatus) : null,
    input.providerMessageId,
  );
  return { ...input, id };
}

export function submissionGet(
  sql: StoreSql,
  ids: string[] | null,
): {
  state: string;
  list: SubmissionRow[];
  notFound: string[];
} {
  const rows = sql
    .all(
      "SELECT * FROM email_submission WHERE (?1 IS NULL OR id IN (SELECT value FROM json_each(?1))) ORDER BY send_at, id",
      ids ? chunkIds(ids) : null,
    )
    .map((r) => submissionFromRow(sql, r));
  const found = new Set(rows.map((r) => r.id));
  return {
    state: sql.state("EmailSubmission"),
    list: rows,
    notFound: ids ? ids.filter((i) => !found.has(i)) : [],
  };
}

export function submissionQuery(
  sql: StoreSql,
  p: SubmissionQueryParams,
): {
  queryState: string;
  ids: string[];
  total: number;
  position: number;
} {
  const where: string[] = [];
  const binds: SqlValue[] = [];
  const f = p.filter;
  if (f.identityIds) {
    where.push("identity_id IN (SELECT value FROM json_each(?))");
    binds.push(chunkIds(f.identityIds));
  }
  if (f.emailIds) {
    where.push("email_id IN (SELECT value FROM json_each(?))");
    binds.push(chunkIds(f.emailIds));
  }
  if (f.threadIds) {
    where.push("thread_id IN (SELECT value FROM json_each(?))");
    binds.push(chunkIds(f.threadIds));
  }
  if (f.undoStatus) {
    where.push("undo_status = ?");
    binds.push(f.undoStatus);
  }
  if (f.before !== undefined) {
    where.push("send_at < ?");
    binds.push(f.before);
  }
  if (f.after !== undefined) {
    where.push("send_at >= ?");
    binds.push(f.after);
  }
  const w = where.length > 0 ? `WHERE ${where.join(" AND ")}` : "";
  const total =
    sql.first<{ n: number }>(`SELECT count(*) AS n FROM email_submission ${w}`, ...binds)?.n ?? 0;
  const ids = sql
    .all<{ id: string }>(
      `SELECT id FROM email_submission ${w} ORDER BY send_at ${p.sortAscending ? "ASC" : "DESC"}, id LIMIT ? OFFSET ?`,
      ...binds,
      p.limit ?? -1,
      p.position,
    )
    .map((r) => r.id);
  return { queryState: sql.state("EmailSubmission"), ids, total, position: p.position };
}

export function submissionDestroy(
  sql: StoreSql,
  ids: string[],
): { destroyed: string[]; notFound: string[] } {
  const existing = new Set(
    sql
      .all<{ id: string }>(
        "SELECT id FROM email_submission WHERE id IN (SELECT value FROM json_each(?))",
        chunkIds(ids),
      )
      .map((r) => r.id),
  );
  sql.run(
    "DELETE FROM email_submission WHERE id IN (SELECT value FROM json_each(?))",
    chunkIds(ids),
  );
  return {
    destroyed: ids.filter((i) => existing.has(i)),
    notFound: ids.filter((i) => !existing.has(i)),
  };
}
