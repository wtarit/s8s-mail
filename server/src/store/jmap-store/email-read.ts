import { compileEmailQuery, QueryError } from "../jmap-filter";
import type {
  EmailForSubmission,
  EmailGetResult,
  EmailQueryParams,
  EmailQueryResult,
  EmailRow,
  SnippetRow,
  ThreadGetResult,
} from "../jmap-types";
import type { BodyPart, EmailAddress } from "../types";
import { chunkIds, json, type StoreSql } from "./sql";

export function threadGet(sql: StoreSql, ids: string[]): ThreadGetResult {
  const rows = sql.all<{ thread_id: string; id: string }>(
    `SELECT thread_id, id FROM email WHERE thread_id IN (SELECT value FROM json_each(?))
     ORDER BY received_at, rowid`,
    chunkIds(ids),
  );
  const map = new Map<string, string[]>();
  for (const r of rows) {
    const list = map.get(r.thread_id) ?? [];
    list.push(r.id);
    map.set(r.thread_id, list);
  }
  return {
    state: sql.state("Thread"),
    list: ids.filter((i) => map.has(i)).map((id) => ({ id, emailIds: map.get(id)! })),
    notFound: ids.filter((i) => !map.has(i)),
  };
}

// --- Email: read ---------------------------------------------------------------------

export function emailGet(sql: StoreSql, ids: string[], withBody: boolean): EmailGetResult {
  const idJson = chunkIds(ids);
  const bodyCols = withBody ? ", e.body_structure, e.text_body, e.html_body, e.attachments" : "";
  const rows = sql.all(
    `SELECT e.id, e.blob_id, e.thread_id, e.size, e.received_at, e.sent_at, e.message_id,
       e.in_reply_to, e."references" AS refs, e.subject, e."from" AS fromCol, e.sender, e."to" AS toCol,
       e.cc, e.bcc, e.reply_to, e.preview, e.has_attachment, e.parse_state${bodyCols}
     FROM email e WHERE e.id IN (SELECT value FROM json_each(?))`,
    idJson,
  );
  const mailboxes = new Map<string, string[]>();
  for (const r of sql.all<{ email_id: string; mailbox_id: string }>(
    "SELECT email_id, mailbox_id FROM email_mailbox WHERE email_id IN (SELECT value FROM json_each(?))",
    idJson,
  )) {
    const list = mailboxes.get(r.email_id) ?? [];
    list.push(r.mailbox_id);
    mailboxes.set(r.email_id, list);
  }
  const keywords = new Map<string, string[]>();
  for (const r of sql.all<{ email_id: string; keyword: string }>(
    "SELECT email_id, keyword FROM email_keyword WHERE email_id IN (SELECT value FROM json_each(?))",
    idJson,
  )) {
    const list = keywords.get(r.email_id) ?? [];
    list.push(r.keyword);
    keywords.set(r.email_id, list);
  }
  const out: EmailRow[] = rows.map((r) => {
    const row: EmailRow = {
      id: r.id as string,
      blobId: r.blob_id as string,
      threadId: r.thread_id as string,
      size: r.size as number,
      receivedAt: r.received_at as number,
      sentAt: (r.sent_at as number | null) ?? null,
      messageId: (r.message_id as string | null) ?? null,
      inReplyTo: json<string[]>(r.in_reply_to),
      references: json<string[]>(r.refs),
      subject: (r.subject as string | null) ?? null,
      from: json<EmailAddress[]>(r.fromCol),
      sender: json<EmailAddress[]>(r.sender),
      to: json<EmailAddress[]>(r.toCol),
      cc: json<EmailAddress[]>(r.cc),
      bcc: json<EmailAddress[]>(r.bcc),
      replyTo: json<EmailAddress[]>(r.reply_to),
      preview: r.preview as string,
      hasAttachment: r.has_attachment === 1,
      parseState: r.parse_state as EmailRow["parseState"],
      mailboxIds: mailboxes.get(r.id as string) ?? [],
      keywords: keywords.get(r.id as string) ?? [],
    };
    if (withBody) {
      row.bodyStructure = json<BodyPart>(r.body_structure);
      row.textBody = json<BodyPart[]>(r.text_body);
      row.htmlBody = json<BodyPart[]>(r.html_body);
      row.attachments = json<BodyPart[]>(r.attachments);
    }
    return row;
  });
  const found = new Set(out.map((r) => r.id));
  return {
    state: sql.state("Email"),
    rows: out,
    notFound: ids.filter((i) => !found.has(i)),
  };
}

export function emailQuery(sql: StoreSql, p: EmailQueryParams): EmailQueryResult {
  try {
    const q = compileEmailQuery(p.filter, p.sort, p.collapseThreads);
    const queryState = sql.state("Email");
    let position = p.position;
    if (p.anchor !== null || position < 0) {
      const all = sql.all<{ id: string }>(q.idsSql, ...q.idsParams).map((r) => r.id);
      if (p.anchor !== null) {
        const idx = all.indexOf(p.anchor);
        if (idx < 0) {
          return { ok: false, error: { type: "anchorNotFound" } };
        }
        position = Math.max(0, idx + p.anchorOffset);
      } else {
        position = Math.max(0, all.length + position);
      }
      const page = all.slice(position, p.limit === null ? undefined : position + p.limit);
      return {
        ok: true,
        queryState,
        ids: page,
        position,
        total: p.calculateTotal ? all.length : null,
      };
    }
    const limit = p.limit === null ? -1 : p.limit;
    const ids =
      limit === 0
        ? []
        : sql
            .all<{ id: string }>(`${q.idsSql} LIMIT ? OFFSET ?`, ...q.idsParams, limit, position)
            .map((r) => r.id);
    const total = p.calculateTotal
      ? (sql.first<{ n: number }>(q.countSql, ...q.countParams)?.n ?? 0)
      : null;
    return { ok: true, queryState, ids, position, total };
  } catch (err) {
    if (err instanceof QueryError) {
      return { ok: false, error: { type: err.type, description: err.message } };
    }
    throw err;
  }
}

/** FTS snippets for SearchSnippet/get. Markers are U+E000/U+E001 (the Worker escapes + converts). */
export function snippets(sql: StoreSql, emailIds: string[], ftsQuery: string | null): SnippetRow[] {
  const idJson = chunkIds(emailIds);
  const hits = new Map<string, { subject: string | null; preview: string | null }>();
  if (ftsQuery) {
    for (const r of sql.all<{ id: string; subj: string | null; body: string | null }>(
      `SELECT e.id AS id,
         highlight(email_fts, 0, char(57344), char(57345)) AS subj,
         snippet(email_fts, 3, char(57344), char(57345), '…', 24) AS body
       FROM email_fts JOIN email e ON e.rowid = email_fts.rowid
       WHERE email_fts MATCH ? AND e.id IN (SELECT value FROM json_each(?))`,
      ftsQuery,
      idJson,
    )) {
      hits.set(r.id, { subject: r.subj, preview: r.body });
    }
  }
  const subjects = new Map(
    sql
      .all<{ id: string; subject: string | null; preview: string }>(
        "SELECT id, subject, preview FROM email WHERE id IN (SELECT value FROM json_each(?))",
        idJson,
      )
      .map((r) => [r.id, r]),
  );
  return emailIds
    .filter((id) => subjects.has(id))
    .map((id) => {
      const hit = hits.get(id);
      return {
        emailId: id,
        subject: hit?.subject ?? subjects.get(id)!.subject,
        preview: hit?.preview && hit.preview.includes("") ? hit.preview : null,
      };
    });
}

export function emailForSubmission(sql: StoreSql, emailId: string): EmailForSubmission | null {
  const r = sql.first(
    `SELECT id, blob_id, thread_id, size, "from" AS fromCol, sender, "to" AS toCol, cc, bcc,
       attachments, parse_state FROM email WHERE id = ?`,
    emailId,
  );
  if (!r) return null;
  const attachments = json<BodyPart[]>(r.attachments);
  return {
    id: r.id as string,
    blobId: r.blob_id as string,
    threadId: r.thread_id as string,
    size: r.size as number,
    from: json<EmailAddress[]>(r.fromCol) ?? [],
    sender: json<EmailAddress[]>(r.sender) ?? [],
    to: json<EmailAddress[]>(r.toCol) ?? [],
    cc: json<EmailAddress[]>(r.cc) ?? [],
    bcc: json<EmailAddress[]>(r.bcc) ?? [],
    attachmentBytes:
      r.parse_state === "parsed" && attachments
        ? attachments.reduce((n, a) => n + a.size, 0)
        : null,
  };
}
