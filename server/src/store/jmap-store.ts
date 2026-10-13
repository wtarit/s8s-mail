/**
 * JMAP-facing queries and writes against the account DO's SQLite. `AccountDO` exposes thin
 * RPC wrappers around these. Data in/out is plain (see ./jmap-types.ts); the Worker does
 * the JMAP wire formatting.
 *
 * Notes:
 *  - Durable Object SQL allows at most 100 bound parameters per statement, so id lists are
 *    passed as ONE JSON parameter and expanded with `json_each(?)`.
 *  - Every write runs in `transactionSync`. Triggers (drizzle/do/*.sql) maintain change_log.
 */
import { newId } from "./blob";
import { compileEmailQuery, QueryError, type SqlValue } from "./jmap-filter";
import type {
  AllStates,
  ChangesResult,
  EmailDestroyResult,
  EmailForSubmission,
  EmailGetResult,
  EmailQueryParams,
  EmailQueryResult,
  EmailRow,
  EmailUpdateInput,
  EmailUpdateResult,
  IdentitySettingRow,
  IdentitySettingUpdate,
  MailboxGetResult,
  MailboxQueryParams,
  MailboxQueryResult,
  MailboxRow,
  MailboxSetParams,
  MailboxSetResult,
  SetOp,
  SnippetRow,
  StoreError,
  SubmissionCreateInput,
  SubmissionQueryParams,
  SubmissionRow,
  ThreadGetResult,
} from "./jmap-types";
import type { BodyPart, EmailAddress } from "./types";

type Row = Record<string, SqlValue | ArrayBuffer>;

const COUNT_PROPERTIES = ["totalEmails", "unreadEmails", "totalThreads", "unreadThreads"];
export const MAX_MAILBOX_DEPTH = 10;
export const MAX_MAILBOX_NAME = 255;
const VALID_ROLES = new Set(["archive", "drafts", "important", "inbox", "junk", "sent", "trash"]);
const SYSTEM_ROLES = new Set(["inbox", "drafts", "sent", "junk", "trash", "archive"]);

function json<T>(text: unknown): T | null {
  if (typeof text !== "string") return null;
  try {
    return JSON.parse(text) as T;
  } catch {
    return null;
  }
}

function chunkIds(ids: string[]): string {
  return JSON.stringify(ids);
}

export class JmapStore {
  constructor(private readonly storage: DurableObjectStorage) {}

  // --- SQL helpers ---------------------------------------------------------------------

  private all<T extends Row = Row>(query: string, ...binds: SqlValue[]): T[] {
    return this.storage.sql.exec<T>(query, ...binds).toArray();
  }

  private first<T extends Row = Row>(query: string, ...binds: SqlValue[]): T | undefined {
    return this.all<T>(query, ...binds)[0];
  }

  private run(query: string, ...binds: SqlValue[]): void {
    this.storage.sql.exec(query, ...binds);
  }

  // --- State ---------------------------------------------------------------------------

  state(type: string): string {
    const row = this.first<{ m: number | null }>(
      "SELECT MAX(seq) AS m FROM change_log WHERE type = ?",
      type,
    );
    return String(row?.m ?? 0);
  }

  states(): AllStates {
    return {
      Email: this.state("Email"),
      Mailbox: this.state("Mailbox"),
      Thread: this.state("Thread"),
      EmailSubmission: this.state("EmailSubmission"),
      Identity: this.state("Identity"),
    };
  }

  /**
   * Foo/changes (RFC 8620 §5.2). Entries of an object inside (since, newState] collapse as:
   * last = destroyed -> destroyed (nothing if its first entry is "created"); else first =
   * created -> created; else updated. With more than `maxChanges` objects, `newState` is
   * the seq of the maxChanges-th object's first entry, and only entries up to it count.
   */
  changes(type: string, sinceState: string, maxChanges: number): ChangesResult {
    if (!/^\d{1,15}$/.test(sinceState)) {
      return { ok: false, error: { type: "cannotCalculateChanges" } };
    }
    const since = Number(sinceState);
    const current = Number(this.state(type));
    if (since > current) return { ok: false, error: { type: "cannotCalculateChanges" } };
    const firsts = this.all<{ object_id: string; first_seq: number }>(
      "SELECT object_id, MIN(seq) AS first_seq FROM change_log WHERE type = ? AND seq > ? GROUP BY object_id ORDER BY first_seq LIMIT ?",
      type,
      since,
      maxChanges + 1,
    );
    let upTo = current;
    let hasMore = false;
    if (firsts.length > maxChanges) {
      upTo = firsts[maxChanges - 1]!.first_seq;
      hasMore = true;
    }
    const entries = this.all<{ object_id: string; kind: string; counts_only: number }>(
      "SELECT object_id, kind, counts_only FROM change_log WHERE type = ? AND seq > ? AND seq <= ? ORDER BY seq",
      type,
      since,
      upTo,
    );
    const byObject = new Map<string, { kind: string; counts_only: number }[]>();
    for (const e of entries) {
      const list = byObject.get(e.object_id) ?? [];
      list.push(e);
      byObject.set(e.object_id, list);
    }
    const created: string[] = [];
    const updated: string[] = [];
    const destroyed: string[] = [];
    let allCountsOnly = true;
    for (const [id, list] of byObject) {
      const firstKind = list[0]!.kind;
      const lastKind = list[list.length - 1]!.kind;
      if (lastKind === "destroyed") {
        if (firstKind !== "created") destroyed.push(id);
      } else if (firstKind === "created") {
        created.push(id);
      } else {
        updated.push(id);
        if (!list.every((e) => e.counts_only === 1)) allCountsOnly = false;
      }
    }
    return {
      ok: true,
      oldState: sinceState,
      newState: String(upTo),
      hasMoreChanges: hasMore,
      created,
      updated,
      destroyed,
      updatedProperties:
        type === "Mailbox" && updated.length > 0 && allCountsOnly ? COUNT_PROPERTIES : null,
    };
  }

  // --- Mailbox -------------------------------------------------------------------------

  private mailboxRows(ids: string[] | null): MailboxRow[] {
    const unreadPred =
      "NOT EXISTS (SELECT 1 FROM email_keyword k WHERE k.email_id = %ID% AND k.keyword IN ('$seen', '$draft'))";
    const rows = this.all(
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

  mailboxGet(ids: string[] | null): MailboxGetResult {
    const list = this.mailboxRows(ids);
    const found = new Set(list.map((m) => m.id));
    return {
      state: this.state("Mailbox"),
      list,
      notFound: ids ? ids.filter((i) => !found.has(i)) : [],
    };
  }

  mailboxQuery(p: MailboxQueryParams): MailboxQueryResult {
    let rows = this.mailboxRows(null);
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
      queryState: this.state("Mailbox"),
      ids: page.map((m) => m.id),
      total,
      position,
    };
  }

  private mailboxDepth(id: string | null): number {
    let depth = 0;
    let cur = id;
    const seen = new Set<string>();
    while (cur && !seen.has(cur) && depth <= MAX_MAILBOX_DEPTH + 1) {
      seen.add(cur);
      depth++;
      cur =
        this.first<{ parent_id: string | null }>("SELECT parent_id FROM mailbox WHERE id = ?", cur)
          ?.parent_id ?? null;
    }
    return depth;
  }

  private isDescendant(candidate: string, ancestor: string): boolean {
    let cur: string | null = candidate;
    const seen = new Set<string>();
    while (cur && !seen.has(cur)) {
      if (cur === ancestor) return true;
      seen.add(cur);
      cur =
        this.first<{ parent_id: string | null }>("SELECT parent_id FROM mailbox WHERE id = ?", cur)
          ?.parent_id ?? null;
    }
    return false;
  }

  private siblingNameTaken(name: string, parentId: string | null, exceptId: string | null) {
    return !!this.first(
      "SELECT 1 AS x FROM mailbox WHERE lower(name) = lower(?) AND parent_id IS ? AND id IS NOT ?",
      name,
      parentId,
      exceptId,
    );
  }

  private validateName(name: string): StoreError | null {
    if (name.trim() === "" || name.length > MAX_MAILBOX_NAME || [...name].some((ch) => ch.charCodeAt(0) < 32)) {
      return {
        type: "invalidProperties",
        properties: ["name"],
        description: `Mailbox name must be 1-${MAX_MAILBOX_NAME} characters without control characters`,
      };
    }
    return null;
  }

  /** Caller wraps this in a transaction. Returns blob ids of removed emails. */
  mailboxSet(p: MailboxSetParams): MailboxSetResult {
    const oldState = this.state("Mailbox");
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
        const err = this.createMailbox(c, parentId);
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
      const rows = this.mailboxRows([...createdIds.values()]);
      for (const [key, id] of createdIds) {
        const row = rows.find((r) => r.id === id);
        if (row) created[key] = row;
      }
    }

    for (const u of p.update) {
      const err = this.updateMailbox(u);
      if (err) notUpdated[u.id] = err;
      else updated.push(u.id);
    }

    for (const id of p.destroy) {
      const mb = this.first<{ id: string; role: string | null }>(
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
      if (this.first("SELECT 1 AS x FROM mailbox WHERE parent_id = ?", id)) {
        notDestroyed[id] = { type: "mailboxHasChild" };
        continue;
      }
      const members = this.all<{ email_id: string }>(
        "SELECT email_id FROM email_mailbox WHERE mailbox_id = ?",
        id,
      );
      if (members.length > 0 && !p.onDestroyRemoveEmails) {
        notDestroyed[id] = { type: "mailboxHasEmail" };
        continue;
      }
      if (members.length > 0) {
        // Emails only in this mailbox are destroyed; others just leave it.
        const only = this.all<{ email_id: string }>(
          `SELECT em.email_id FROM email_mailbox em WHERE em.mailbox_id = ?
           AND NOT EXISTS (SELECT 1 FROM email_mailbox o WHERE o.email_id = em.email_id AND o.mailbox_id <> em.mailbox_id)`,
          id,
        ).map((r) => r.email_id);
        const { blobIds } = this.deleteEmails(only);
        removedBlobIds.push(...blobIds);
        this.run("DELETE FROM email_mailbox WHERE mailbox_id = ?", id);
      }
      this.run("DELETE FROM mailbox WHERE id = ?", id);
      destroyed.push(id);
    }

    return {
      ok: true,
      oldState,
      newState: this.state("Mailbox"),
      created,
      notCreated,
      updated,
      notUpdated,
      destroyed,
      notDestroyed,
      removedBlobIds,
    };
  }

  /** Inserts a mailbox; returns its id, or the error. */
  private createMailbox(c: MailboxSetParams["create"][number], parentId: string | null) {
    const nameErr = this.validateName(c.name);
    if (nameErr) return nameErr;
    if (parentId !== null) {
      if (!this.first("SELECT 1 AS x FROM mailbox WHERE id = ?", parentId)) {
        return {
          type: "invalidProperties",
          properties: ["parentId"],
          description: "Unknown parent",
        };
      }
      if (this.mailboxDepth(parentId) >= MAX_MAILBOX_DEPTH) {
        return {
          type: "invalidProperties",
          properties: ["parentId"],
          description: `Mailboxes can be nested at most ${MAX_MAILBOX_DEPTH} deep`,
        };
      }
    }
    if (this.siblingNameTaken(c.name, parentId, null)) {
      return {
        type: "invalidProperties",
        properties: ["name"],
        description: "A sibling mailbox with this name exists",
      };
    }
    if (c.role !== null) {
      if (!VALID_ROLES.has(c.role)) {
        return { type: "invalidProperties", properties: ["role"], description: "Unsupported role" };
      }
      if (this.first("SELECT 1 AS x FROM mailbox WHERE role = ?", c.role)) {
        return {
          type: "invalidProperties",
          properties: ["role"],
          description: "Another mailbox already has this role",
        };
      }
    }
    const id = newId("b");
    this.run(
      "INSERT INTO mailbox (id, name, parent_id, role, sort_order, is_subscribed) VALUES (?, ?, ?, ?, ?, ?)",
      id,
      c.name,
      parentId,
      c.role,
      c.sortOrder,
      c.isSubscribed ? 1 : 0,
    );
    return id;
  }

  private updateMailbox(u: MailboxSetParams["update"][number]): StoreError | null {
    const cur = this.first<{
      id: string;
      name: string;
      parent_id: string | null;
      role: string | null;
    }>("SELECT id, name, parent_id, role FROM mailbox WHERE id = ?", u.id);
    if (!cur) return { type: "notFound" };
    const name = u.name ?? cur.name;
    const parentId = u.parentId !== undefined ? u.parentId : cur.parent_id;
    if (u.name !== undefined) {
      const err = this.validateName(u.name);
      if (err) return err;
    }
    if (u.parentId !== undefined && u.parentId !== null) {
      if (!this.first("SELECT 1 AS x FROM mailbox WHERE id = ?", u.parentId)) {
        return {
          type: "invalidProperties",
          properties: ["parentId"],
          description: "Unknown parent",
        };
      }
      if (this.isDescendant(u.parentId, u.id)) {
        return {
          type: "invalidProperties",
          properties: ["parentId"],
          description: "A mailbox cannot be moved under itself",
        };
      }
      if (this.mailboxDepth(u.parentId) >= MAX_MAILBOX_DEPTH) {
        return {
          type: "invalidProperties",
          properties: ["parentId"],
          description: `Mailboxes can be nested at most ${MAX_MAILBOX_DEPTH} deep`,
        };
      }
    }
    if (
      (u.name !== undefined || u.parentId !== undefined) &&
      this.siblingNameTaken(name, parentId, u.id)
    ) {
      return {
        type: "invalidProperties",
        properties: ["name"],
        description: "A sibling mailbox with this name exists",
      };
    }
    if (u.role !== undefined && u.role !== cur.role) {
      if (cur.role !== null) {
        return { type: "forbidden", description: "The role of a mailbox cannot be changed" };
      }
      if (u.role !== null) {
        if (!VALID_ROLES.has(u.role)) {
          return {
            type: "invalidProperties",
            properties: ["role"],
            description: "Unsupported role",
          };
        }
        if (this.first("SELECT 1 AS x FROM mailbox WHERE role = ?", u.role)) {
          return {
            type: "invalidProperties",
            properties: ["role"],
            description: "Another mailbox already has this role",
          };
        }
      }
    }
    this.run(
      `UPDATE mailbox SET name = ?, parent_id = ?, role = ?, sort_order = COALESCE(?, sort_order),
         is_subscribed = COALESCE(?, is_subscribed) WHERE id = ?`,
      name,
      parentId,
      u.role !== undefined ? u.role : cur.role,
      u.sortOrder ?? null,
      u.isSubscribed === undefined ? null : u.isSubscribed ? 1 : 0,
      u.id,
    );
    return null;
  }

  // --- Thread --------------------------------------------------------------------------

  threadGet(ids: string[]): ThreadGetResult {
    const rows = this.all<{ thread_id: string; id: string }>(
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
      state: this.state("Thread"),
      list: ids.filter((i) => map.has(i)).map((id) => ({ id, emailIds: map.get(id)! })),
      notFound: ids.filter((i) => !map.has(i)),
    };
  }

  // --- Email: read ---------------------------------------------------------------------

  emailGet(ids: string[], withBody: boolean): EmailGetResult {
    const idJson = chunkIds(ids);
    const bodyCols = withBody ? ", e.body_structure, e.text_body, e.html_body, e.attachments" : "";
    const rows = this.all(
      `SELECT e.id, e.blob_id, e.thread_id, e.size, e.received_at, e.sent_at, e.message_id,
         e.in_reply_to, e."references" AS refs, e.subject, e."from" AS fromCol, e.sender, e."to" AS toCol,
         e.cc, e.bcc, e.reply_to, e.preview, e.has_attachment, e.parse_state${bodyCols}
       FROM email e WHERE e.id IN (SELECT value FROM json_each(?))`,
      idJson,
    );
    const mailboxes = new Map<string, string[]>();
    for (const r of this.all<{ email_id: string; mailbox_id: string }>(
      "SELECT email_id, mailbox_id FROM email_mailbox WHERE email_id IN (SELECT value FROM json_each(?))",
      idJson,
    )) {
      const list = mailboxes.get(r.email_id) ?? [];
      list.push(r.mailbox_id);
      mailboxes.set(r.email_id, list);
    }
    const keywords = new Map<string, string[]>();
    for (const r of this.all<{ email_id: string; keyword: string }>(
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
      state: this.state("Email"),
      rows: out,
      notFound: ids.filter((i) => !found.has(i)),
    };
  }

  emailQuery(p: EmailQueryParams): EmailQueryResult {
    try {
      const q = compileEmailQuery(p.filter, p.sort, p.collapseThreads);
      const queryState = this.state("Email");
      let position = p.position;
      if (p.anchor !== null || position < 0) {
        const all = this.all<{ id: string }>(q.idsSql, ...q.idsParams).map((r) => r.id);
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
          : this.all<{ id: string }>(
              `${q.idsSql} LIMIT ? OFFSET ?`,
              ...q.idsParams,
              limit,
              position,
            ).map((r) => r.id);
      const total = p.calculateTotal
        ? (this.first<{ n: number }>(q.countSql, ...q.countParams)?.n ?? 0)
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
  snippets(emailIds: string[], ftsQuery: string | null): SnippetRow[] {
    const idJson = chunkIds(emailIds);
    const hits = new Map<string, { subject: string | null; preview: string | null }>();
    if (ftsQuery) {
      for (const r of this.all<{ id: string; subj: string | null; body: string | null }>(
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
      this.all<{ id: string; subject: string | null; preview: string }>(
        "SELECT id, subject, preview FROM email WHERE id IN (SELECT value FROM json_each(?))",
        idJson,
      ).map((r) => [r.id, r]),
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

  // --- Email: write --------------------------------------------------------------------

  private applySetOp(current: string[], op: SetOp): string[] {
    const next = op.set ? new Set(op.set) : new Set(current);
    for (const a of op.add ?? []) next.add(a);
    for (const r of op.remove ?? []) next.delete(r);
    return [...next];
  }

  emailUpdate(updates: EmailUpdateInput[]): EmailUpdateResult {
    const oldState = this.state("Email");
    const results: EmailUpdateResult["results"] = {};
    const mailboxIds = new Set(this.all<{ id: string }>("SELECT id FROM mailbox").map((m) => m.id));
    for (const u of updates) {
      if (!this.first("SELECT 1 AS x FROM email WHERE id = ?", u.id)) {
        results[u.id] = { ok: false, error: { type: "notFound" } };
        continue;
      }
      let nextBoxes: string[] | null = null;
      let curBoxes: string[] = [];
      if (u.mailboxIds) {
        curBoxes = this.all<{ mailbox_id: string }>(
          "SELECT mailbox_id FROM email_mailbox WHERE email_id = ?",
          u.id,
        ).map((r) => r.mailbox_id);
        nextBoxes = this.applySetOp(curBoxes, u.mailboxIds);
        if (nextBoxes.length === 0) {
          results[u.id] = {
            ok: false,
            error: {
              type: "invalidProperties",
              properties: ["mailboxIds"],
              description: "An email must be in at least one mailbox",
            },
          };
          continue;
        }
        const unknown = nextBoxes.find((b) => !mailboxIds.has(b));
        if (unknown !== undefined) {
          results[u.id] = {
            ok: false,
            error: {
              type: "invalidProperties",
              properties: ["mailboxIds"],
              description: `Unknown mailbox ${unknown}`,
            },
          };
          continue;
        }
      }
      if (nextBoxes) {
        const before = new Set(curBoxes);
        const after = new Set(nextBoxes);
        for (const b of after) {
          if (!before.has(b)) {
            this.run("INSERT INTO email_mailbox (email_id, mailbox_id) VALUES (?, ?)", u.id, b);
          }
        }
        for (const b of before) {
          if (!after.has(b)) {
            this.run("DELETE FROM email_mailbox WHERE email_id = ? AND mailbox_id = ?", u.id, b);
          }
        }
      }
      if (u.keywords) {
        const cur = this.all<{ keyword: string }>(
          "SELECT keyword FROM email_keyword WHERE email_id = ?",
          u.id,
        ).map((r) => r.keyword);
        const after = new Set(this.applySetOp(cur, u.keywords));
        const before = new Set(cur);
        for (const k of after) {
          if (!before.has(k)) {
            this.run("INSERT INTO email_keyword (email_id, keyword) VALUES (?, ?)", u.id, k);
          }
        }
        for (const k of before) {
          if (!after.has(k)) {
            this.run("DELETE FROM email_keyword WHERE email_id = ? AND keyword = ?", u.id, k);
          }
        }
      }
      results[u.id] = { ok: true };
    }
    return { oldState, newState: this.state("Email"), results };
  }

  /** Deletes emails (rows, membership, keywords); returns the R2 blob ids to remove. */
  deleteEmails(ids: string[]): { destroyed: string[]; blobIds: string[] } {
    if (ids.length === 0) return { destroyed: [], blobIds: [] };
    const idJson = chunkIds(ids);
    const rows = this.all<{ id: string; blob_id: string }>(
      "SELECT id, blob_id FROM email WHERE id IN (SELECT value FROM json_each(?))",
      idJson,
    );
    const parts = this.all<{ v: string }>(
      `SELECT DISTINCT j.value AS v FROM email e, json_tree(e.body_structure) j
        WHERE e.id IN (SELECT value FROM json_each(?)) AND j.key = 'blobId' AND j.type = 'text'`,
      idJson,
    ).map((r) => r.v);
    this.run(
      "DELETE FROM email_mailbox WHERE email_id IN (SELECT value FROM json_each(?))",
      idJson,
    );
    this.run(
      "DELETE FROM email_keyword WHERE email_id IN (SELECT value FROM json_each(?))",
      idJson,
    );
    this.run("DELETE FROM email WHERE id IN (SELECT value FROM json_each(?))", idJson);
    return {
      destroyed: rows.map((r) => r.id),
      blobIds: [...new Set([...rows.map((r) => r.blob_id), ...parts])],
    };
  }

  emailDestroy(ids: string[]): EmailDestroyResult {
    const oldState = this.state("Email");
    const { destroyed, blobIds } = this.deleteEmails(ids);
    const done = new Set(destroyed);
    return {
      oldState,
      newState: this.state("Email"),
      destroyed,
      notFound: ids.filter((i) => !done.has(i)),
      blobIds,
    };
  }

  mailboxIdsExist(ids: string[]): boolean {
    const n = this.first<{ n: number }>(
      "SELECT count(*) AS n FROM mailbox WHERE id IN (SELECT value FROM json_each(?))",
      chunkIds(ids),
    )?.n;
    return n === new Set(ids).size;
  }

  emailForSubmission(emailId: string): EmailForSubmission | null {
    const r = this.first(
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

  // --- Identity settings ---------------------------------------------------------------

  identitySettings(): IdentitySettingRow[] {
    return this.all(
      "SELECT address, name, reply_to, bcc, text_signature, html_signature FROM identity_setting",
    ).map((r) => ({
      address: r.address as string,
      name: (r.name as string | null) ?? null,
      replyTo: json<EmailAddress[]>(r.reply_to),
      bcc: json<EmailAddress[]>(r.bcc),
      textSignature: (r.text_signature as string | null) ?? null,
      htmlSignature: (r.html_signature as string | null) ?? null,
    }));
  }

  identitySettingsSet(address: string, update: IdentitySettingUpdate): void {
    const cur = this.identitySettings().find((s) => s.address === address);
    const next = {
      name: update.name !== undefined ? update.name : (cur?.name ?? null),
      replyTo: update.replyTo !== undefined ? update.replyTo : (cur?.replyTo ?? null),
      bcc: update.bcc !== undefined ? update.bcc : (cur?.bcc ?? null),
      textSignature:
        update.textSignature !== undefined ? update.textSignature : (cur?.textSignature ?? null),
      htmlSignature:
        update.htmlSignature !== undefined ? update.htmlSignature : (cur?.htmlSignature ?? null),
    };
    this.run(
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

  private submissionFromRow(r: Row): SubmissionRow {
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

  submissionCreate(input: SubmissionCreateInput): SubmissionRow {
    const id = newId("e").replace(/^e/, "s");
    this.run(
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

  submissionGet(ids: string[] | null): {
    state: string;
    list: SubmissionRow[];
    notFound: string[];
  } {
    const rows = this.all(
      "SELECT * FROM email_submission WHERE (?1 IS NULL OR id IN (SELECT value FROM json_each(?1))) ORDER BY send_at, id",
      ids ? chunkIds(ids) : null,
    ).map((r) => this.submissionFromRow(r));
    const found = new Set(rows.map((r) => r.id));
    return {
      state: this.state("EmailSubmission"),
      list: rows,
      notFound: ids ? ids.filter((i) => !found.has(i)) : [],
    };
  }

  submissionQuery(p: SubmissionQueryParams): {
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
      this.first<{ n: number }>(`SELECT count(*) AS n FROM email_submission ${w}`, ...binds)?.n ??
      0;
    const ids = this.all<{ id: string }>(
      `SELECT id FROM email_submission ${w} ORDER BY send_at ${p.sortAscending ? "ASC" : "DESC"}, id LIMIT ? OFFSET ?`,
      ...binds,
      p.limit ?? -1,
      p.position,
    ).map((r) => r.id);
    return { queryState: this.state("EmailSubmission"), ids, total, position: p.position };
  }

  submissionDestroy(ids: string[]): { destroyed: string[]; notFound: string[] } {
    const existing = new Set(
      this.all<{ id: string }>(
        "SELECT id FROM email_submission WHERE id IN (SELECT value FROM json_each(?))",
        chunkIds(ids),
      ).map((r) => r.id),
    );
    this.run(
      "DELETE FROM email_submission WHERE id IN (SELECT value FROM json_each(?))",
      chunkIds(ids),
    );
    return {
      destroyed: ids.filter((i) => existing.has(i)),
      notFound: ids.filter((i) => !existing.has(i)),
    };
  }
}
