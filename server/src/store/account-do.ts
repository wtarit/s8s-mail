import { DurableObject } from "cloudflare:workers";
import { asc, eq, inArray, sql } from "drizzle-orm";
import { drizzle, type DrizzleSqliteDODatabase } from "drizzle-orm/durable-sqlite";
import { migrate } from "drizzle-orm/durable-sqlite/migrator";
import migrations from "../../drizzle/do/migrations";
import { blobKey, MAX_PART_OBJECTS, newId, partBlobId } from "./blob";
import { JmapStore } from "./jmap-store";
import type {
  AllStates,
  ChangesResult,
  EmailCreateInput,
  EmailCreateResult,
  EmailDestroyResult,
  EmailForSubmission,
  EmailGetResult,
  EmailQueryParams,
  EmailQueryResult,
  EmailUpdateInput,
  EmailUpdateResult,
  IdentitySettingRow,
  IdentitySettingUpdate,
  MailboxGetResult,
  MailboxQueryParams,
  MailboxQueryResult,
  MailboxSetParams,
  MailboxSetResult,
  SnippetRow,
  SubmissionCreateInput,
  SubmissionQueryParams,
  SubmissionRow,
  ThreadGetResult,
} from "./jmap-types";
import { parseMessage } from "./parse";
import * as schema from "./schema";
import { threadCandidates } from "./threading";
import type {
  AccountState,
  AccountStore,
  EmailAddress,
  IngestInput,
  IngestResult,
  MailboxRole,
  StateChangeMessage,
} from "./types";

const { meta, mailbox, email, emailMailbox, emailKeyword, threadRef, changeLog } = schema;

/** An email is marked `failed` once its parse has been attempted this many times. */
export const MAX_PARSE_ATTEMPTS = 3;

/** Mailboxes every account starts with (RFC 8621 §2 roles), in display order. */
const SYSTEM_MAILBOXES: { role: MailboxRole; name: string }[] = [
  { role: "inbox", name: "Inbox" },
  { role: "drafts", name: "Drafts" },
  { role: "sent", name: "Sent" },
  { role: "junk", name: "Junk" },
  { role: "trash", name: "Trash" },
  { role: "archive", name: "Archive" },
];

function addressText(list: EmailAddress[] | null | undefined): string {
  return (list ?? []).map((a) => (a.name ? `${a.name} ${a.email}` : a.email)).join(" ");
}

/**
 * One SQLite-backed Durable Object per JMAP account. The single writer for that
 * account's mail data. Reached with `env.ACCOUNT.get(env.ACCOUNT.idFromName(accountId))`.
 *
 * CPU budget: on Workers Free every invocation (RPC, fetch, alarm) gets 10 ms CPU.
 * `ingest()` therefore only writes header-derived rows; the MIME body is parsed later
 * by `alarm()`, one message per invocation. Large messages can exceed 10 ms there and end
 * up `failed` (header data stays available); that is an expected finding of the Free
 * experiment, not a bug.
 *
 * Push: clients subscribe with a WebSocket (`/subscribe`, hibernation API) and receive a
 * JMAP StateChange object after every state change. See ./subscribe.ts.
 */
export class AccountDO extends DurableObject<Env> implements AccountStore {
  readonly db: DrizzleSqliteDODatabase<typeof schema>;
  private readonly jmap: JmapStore;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.db = drizzle(ctx.storage, { schema, logger: false });
    this.jmap = new JmapStore(ctx.storage);
    // Keep-alives are answered without waking a hibernated DO.
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair("ping", "pong"));
    void ctx.blockConcurrencyWhile(() => this.initStore());
  }

  /** Runs migrations, seeds the system mailboxes, and re-arms a lost parse alarm. */
  private async initStore(): Promise<void> {
    await migrate(this.db, migrations);
    this.ctx.storage.transactionSync(() => {
      const existing = this.db
        .select({ n: sql<number>`count(*)` })
        .from(mailbox)
        .get();
      if (!existing?.n) {
        this.db
          .insert(mailbox)
          .values(
            SYSTEM_MAILBOXES.map((m, i) => ({
              id: newId("b"),
              name: m.name,
              role: m.role,
              sortOrder: (i + 1) * 10,
            })),
          )
          .run();
      }
    });
    await this.scheduleParseIfPending();
  }

  // ---------------------------------------------------------------------------------
  // Identity
  // ---------------------------------------------------------------------------------

  /**
   * RPC: records this DO's accountId (DOs do not know their own name). Idempotent; call
   * it first from any new entry point. Throws if the DO already belongs to another account.
   */
  init(accountId: string): void {
    this.db
      .insert(meta)
      .values({ key: "accountId", value: accountId, updatedAt: Date.now() })
      .onConflictDoNothing()
      .run();
    const stored = this.getMeta("accountId");
    if (stored !== accountId) throw new Error(`Durable Object belongs to account ${stored}`);
  }

  /** RPC: read a value from the meta table. */
  getMeta(key: string): string | null {
    return this.db.select().from(meta).where(eq(meta.key, key)).get()?.value ?? null;
  }

  /** RPC: names of the user tables (excludes SQLite, Cloudflare and drizzle internals). */
  listTables(): string[] {
    return this.ctx.storage.sql
      .exec<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
      .toArray()
      .map((r) => r.name)
      .filter(
        (n) => !n.startsWith("sqlite_") && !n.startsWith("_cf_") && !n.startsWith("__drizzle"),
      );
  }

  // ---------------------------------------------------------------------------------
  // State
  // ---------------------------------------------------------------------------------

  private stateOf(type: string): string {
    const row = this.ctx.storage.sql
      .exec<{ m: number | null }>("SELECT MAX(seq) AS m FROM change_log WHERE type = ?", type)
      .one();
    return String(row.m ?? 0);
  }

  /** RPC: JMAP state strings (latest change_log seq per type, "0" if none). */
  getState(): AccountState {
    return {
      Email: this.stateOf("Email"),
      Mailbox: this.stateOf("Mailbox"),
      Thread: this.stateOf("Thread"),
      EmailDelivery: this.stateOf("EmailDelivery"),
    };
  }

  // ---------------------------------------------------------------------------------
  // Ingest
  // ---------------------------------------------------------------------------------

  /**
   * RPC: stores a delivered message (headers only; the raw message is already in R2).
   * One transaction; idempotent per blobId (a retry returns the existing email).
   * Then arms the parse alarm and pushes a StateChange to subscribers.
   */
  async ingest(input: IngestInput): Promise<IngestResult> {
    this.init(input.accountId);
    const result = this.ctx.storage.transactionSync(() =>
      this.insertEmail(input, { role: input.mailboxRole }),
    );
    await this.scheduleParseIfPending();
    if (result.created) this.broadcastStateChange();
    return { emailId: result.emailId, threadId: result.threadId };
  }

  private insertEmail(
    input: Pick<IngestInput, "blobId" | "size" | "receivedAt" | "headers">,
    target:
      | { role: MailboxRole }
      | { mailboxIds: string[]; keywords: string[]; bcc: EmailAddress[] },
  ): IngestResult & { created: boolean } {
    const existing = this.db
      .select({ emailId: email.id, threadId: email.threadId })
      .from(email)
      .where(eq(email.blobId, input.blobId))
      .get();
    if (existing) return { ...existing, created: false };

    let boxIds: string[];
    if ("role" in target) {
      const box = this.db
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
        this.db
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
      this.db
        .insert(threadRef)
        .values(candidates.map((messageId) => ({ messageId, threadId })))
        .onConflictDoNothing()
        .run();
    }

    const emailId = newId("e");
    // The triggers in drizzle/do/0001_*.sql log Email/Thread created here and Mailbox/Email
    // updated for the membership insert below.
    this.db
      .insert(email)
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
    this.db
      .insert(emailMailbox)
      .values(boxIds.map((mailboxId) => ({ emailId, mailboxId })))
      .run();
    if ("keywords" in target && target.keywords.length > 0) {
      this.db
        .insert(emailKeyword)
        .values(target.keywords.map((keyword) => ({ emailId, keyword })))
        .run();
    }
    if ("role" in target) {
      this.db
        .insert(changeLog)
        .values({ type: "EmailDelivery", objectId: emailId, kind: "created" })
        .run();
    }
    return { emailId, threadId, created: true };
  }

  // ---------------------------------------------------------------------------------
  // Deferred body parsing
  // ---------------------------------------------------------------------------------

  private async scheduleParseIfPending(delayMs = 0): Promise<void> {
    const pending = this.db
      .select({ id: email.id })
      .from(email)
      .where(eq(email.parseState, "pending"))
      .limit(1)
      .get();
    if (!pending) return;
    const current = await this.ctx.storage.getAlarm();
    if (current === null) await this.ctx.storage.setAlarm(Date.now() + delayMs);
  }

  /**
   * Parses ONE pending email per invocation (10 ms CPU on Free). The attempt counter is
   * incremented and flushed to disk before any work: an invocation killed for exceeding
   * the CPU limit never reaches its own error handling, so on the next alarm the counter
   * is what marks the message `failed` after MAX_PARSE_ATTEMPTS tries.
   */
  override async alarm(): Promise<void> {
    const row = this.db
      .select()
      .from(email)
      .where(eq(email.parseState, "pending"))
      .orderBy(asc(email.receivedAt))
      .limit(1)
      .get();
    if (!row) return;

    if (row.parseAttempts >= MAX_PARSE_ATTEMPTS) {
      this.markFailed(row.id, row.parseError ?? "parse attempts exhausted (CPU limit?)");
      await this.scheduleParseIfPending();
      return;
    }
    const attempt = row.parseAttempts + 1;
    this.db.update(email).set({ parseAttempts: attempt }).where(eq(email.id, row.id)).run();
    await this.ctx.storage.sync();

    let failed = false;
    try {
      const accountId = this.getMeta("accountId");
      if (!accountId) throw new Error("accountId not set");
      const obj = await this.env.BLOBS.get(blobKey(accountId, row.blobId));
      if (!obj) throw new Error("raw message missing in R2");
      const parsed = await parseMessage(obj.body, row.blobId);

      // Materialize decoded parts so bodies/attachments are served without re-parsing.
      await Promise.all(
        parsed.parts.slice(0, MAX_PART_OBJECTS).map((p) =>
          this.env.BLOBS.put(blobKey(accountId, partBlobId(row.blobId, p.partId)), p.content, {
            httpMetadata: {
              contentType: typeof p.content === "string" ? `${p.type}; charset=utf-8` : p.type,
            },
          }),
        ),
      );

      this.ctx.storage.transactionSync(() => {
        this.db
          .update(email)
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
        const s = this.ctx.storage.sql;
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
      this.broadcastStateChange();
    } catch (err) {
      failed = true;
      const message = err instanceof Error ? err.message : String(err);
      if (attempt >= MAX_PARSE_ATTEMPTS) this.markFailed(row.id, message);
      else this.db.update(email).set({ parseError: message }).where(eq(email.id, row.id)).run();
    }
    await this.scheduleParseIfPending(failed ? 2000 * attempt : 0);
  }

  private markFailed(emailId: string, error: string): void {
    this.db
      .update(email)
      .set({ parseState: "failed", parseError: error })
      .where(eq(email.id, emailId))
      .run();
  }

  // ---------------------------------------------------------------------------------
  // JMAP (RFC 8620/8621) RPC surface. Thin wrappers over ./jmap-store.ts; writes run in
  // one transaction, arm the parse alarm where needed and push a StateChange afterwards.
  // ---------------------------------------------------------------------------------

  /** RPC: every JMAP state string. */
  getAllStates(): AllStates {
    return this.jmap.states();
  }

  /** RPC: `Foo/changes` for Email, Mailbox, Thread, EmailSubmission or Identity. */
  getChanges(type: string, sinceState: string, maxChanges: number): ChangesResult {
    return this.jmap.changes(type, sinceState, maxChanges);
  }

  mailboxGet(ids: string[] | null): MailboxGetResult {
    return this.jmap.mailboxGet(ids);
  }

  mailboxQuery(p: MailboxQueryParams): MailboxQueryResult {
    return this.jmap.mailboxQuery(p);
  }

  mailboxSet(p: MailboxSetParams): MailboxSetResult {
    this.init(p.accountId);
    const result = this.ctx.storage.transactionSync(() => this.jmap.mailboxSet(p));
    if (result.ok && result.oldState !== result.newState) this.broadcastStateChange();
    return result;
  }

  threadGet(ids: string[]): ThreadGetResult {
    return this.jmap.threadGet(ids);
  }

  emailGet(ids: string[], withBody: boolean): EmailGetResult {
    return this.jmap.emailGet(ids, withBody);
  }

  emailQuery(p: EmailQueryParams): EmailQueryResult {
    return this.jmap.emailQuery(p);
  }

  emailSnippets(emailIds: string[], ftsQuery: string | null): SnippetRow[] {
    return this.jmap.snippets(emailIds, ftsQuery);
  }

  emailForSubmission(emailId: string): EmailForSubmission | null {
    return this.jmap.emailForSubmission(emailId);
  }

  /**
   * RPC: inserts an email whose raw message is already in R2 (Email/set create,
   * Email/import). Threads it like a delivery, honors the given mailboxes and keywords,
   * and arms the body-parse alarm.
   */
  async emailCreate(input: EmailCreateInput): Promise<EmailCreateResult> {
    this.init(input.accountId);
    const result = this.ctx.storage.transactionSync((): EmailCreateResult => {
      if (input.mailboxIds.length === 0 || !this.jmap.mailboxIdsExist(input.mailboxIds)) {
        return {
          ok: false,
          error: {
            type: "invalidProperties",
            properties: ["mailboxIds"],
            description: "mailboxIds must name at least one existing mailbox",
          },
        };
      }
      const r = this.insertEmail(input, {
        mailboxIds: [...new Set(input.mailboxIds)],
        keywords: [...new Set(input.keywords)],
        bcc: input.headers.bcc,
      });
      return { ok: true, emailId: r.emailId, threadId: r.threadId };
    });
    if (result.ok) {
      await this.scheduleParseIfPending();
      this.broadcastStateChange();
    }
    return result;
  }

  /** RPC: Email/set update. Per-email results; one broadcast. */
  emailUpdate(accountId: string, updates: EmailUpdateInput[]): EmailUpdateResult {
    this.init(accountId);
    const result = this.ctx.storage.transactionSync(() => this.jmap.emailUpdate(updates));
    if (result.oldState !== result.newState) this.broadcastStateChange();
    return result;
  }

  /** RPC: Email/set destroy. Returns R2 blob ids to delete. */
  emailDestroy(accountId: string, ids: string[]): EmailDestroyResult {
    this.init(accountId);
    const result = this.ctx.storage.transactionSync(() => this.jmap.emailDestroy(ids));
    if (result.destroyed.length > 0) this.broadcastStateChange();
    return result;
  }

  identitySettings(): IdentitySettingRow[] {
    return this.jmap.identitySettings();
  }

  identitySettingsSet(
    accountId: string,
    updates: Record<string, IdentitySettingUpdate>,
  ): { oldState: string; newState: string } {
    this.init(accountId);
    const oldState = this.jmap.state("Identity");
    this.ctx.storage.transactionSync(() => {
      for (const [address, update] of Object.entries(updates)) {
        this.jmap.identitySettingsSet(address, update);
      }
    });
    return { oldState, newState: this.jmap.state("Identity") };
  }

  submissionCreate(input: SubmissionCreateInput): SubmissionRow {
    this.init(input.accountId);
    const row = this.ctx.storage.transactionSync(() => this.jmap.submissionCreate(input));
    this.broadcastStateChange();
    return row;
  }

  submissionGet(ids: string[] | null) {
    return this.jmap.submissionGet(ids);
  }

  submissionQuery(p: SubmissionQueryParams) {
    return this.jmap.submissionQuery(p);
  }

  submissionDestroy(accountId: string, ids: string[]) {
    this.init(accountId);
    return this.ctx.storage.transactionSync(() => this.jmap.submissionDestroy(ids));
  }

  // ---------------------------------------------------------------------------------
  // Delete
  // ---------------------------------------------------------------------------------

  /**
   * RPC: wipes the account (admin deleted the user) and returns every blobId that was
   * referenced (raw messages and materialized parts) so the caller can delete the R2
   * objects (`blobKey(accountId, blobId)`). Leaves a fresh, empty store behind.
   */
  async deleteAll(): Promise<string[]> {
    const rows = this.ctx.storage.sql
      .exec<{ id: string }>(
        `SELECT blob_id AS id FROM email
         UNION
         SELECT j.value FROM email, json_tree(email.body_structure) AS j
          WHERE j.key = 'blobId' AND j.type = 'text'`,
      )
      .toArray();
    for (const ws of this.ctx.getWebSockets()) {
      try {
        ws.close(1001, "account deleted");
      } catch {
        // already closed
      }
    }
    await this.ctx.storage.deleteAlarm();
    await this.ctx.storage.deleteAll();
    await this.ctx.blockConcurrencyWhile(() => this.initStore());
    return rows.map((r) => r.id);
  }

  // ---------------------------------------------------------------------------------
  // Push (WebSocket, hibernation API)
  // ---------------------------------------------------------------------------------

  /** Accepts `GET /subscribe` WebSocket upgrades. Anything else is 404. */
  override async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname !== "/subscribe") return new Response("Not found", { status: 404 });
    if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
      return new Response("Expected a WebSocket upgrade", { status: 426 });
    }
    const accountId = url.searchParams.get("accountId");
    if (accountId) this.init(accountId);

    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];
    this.ctx.acceptWebSocket(server); // hibernation API: the DO can be evicted while idle
    return new Response(null, { status: 101, webSocket: client });
  }

  /** Subscribers are receive-only; incoming messages are ignored. */
  override webSocketMessage(_ws: WebSocket, _message: string | ArrayBuffer): void {}

  override webSocketClose(ws: WebSocket, code: number): void {
    try {
      ws.close(code >= 1000 && code < 5000 && code !== 1005 && code !== 1006 ? code : 1000);
    } catch {
      // already closed
    }
  }

  override webSocketError(ws: WebSocket): void {
    try {
      ws.close(1011, "error");
    } catch {
      // already closed
    }
  }

  /**
   * Sends the current JMAP StateChange to every connected subscriber. Called after ingest
   * and after a parse; the JMAP write paths added later must call it after committing.
   */
  broadcastStateChange(): void {
    const sockets = this.ctx.getWebSockets();
    const accountId = this.getMeta("accountId");
    if (sockets.length === 0 || !accountId) return;
    const message: StateChangeMessage = {
      "@type": "StateChange",
      changed: { [accountId]: this.getState() },
    };
    const payload = JSON.stringify(message);
    for (const ws of sockets) {
      try {
        ws.send(payload);
      } catch {
        // closing socket; the runtime delivers webSocketClose
      }
    }
  }
}
