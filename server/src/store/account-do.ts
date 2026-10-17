import { DurableObject } from "cloudflare:workers";
import { eq, sql } from "drizzle-orm";
import { drizzle, type DrizzleSqliteDODatabase } from "drizzle-orm/durable-sqlite";
import { migrate } from "drizzle-orm/durable-sqlite/migrator";
import migrations from "../../drizzle/do/migrations";
import { newId } from "./blob";
import { insertEmail } from "./email-insert";
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
import { parseNextPending, scheduleParseIfPending } from "./parse-pending";
import { acceptSubscription, broadcastStateChange, closeSubscriber, errorSubscriber } from "./push";
import * as schema from "./schema";
import type { AccountState, AccountStore, IngestInput, IngestResult, MailboxRole } from "./types";

const { meta, mailbox } = schema;

export { MAX_PARSE_ATTEMPTS } from "./parse-pending";

/** Mailboxes every account starts with (RFC 8621 §2 roles), in display order. */
const SYSTEM_MAILBOXES: { role: MailboxRole; name: string }[] = [
  { role: "inbox", name: "Inbox" },
  { role: "drafts", name: "Drafts" },
  { role: "sent", name: "Sent" },
  { role: "junk", name: "Junk" },
  { role: "trash", name: "Trash" },
  { role: "archive", name: "Archive" },
];

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
      insertEmail(this.db, input, { role: input.mailboxRole }),
    );
    await this.scheduleParseIfPending();
    if (result.created) this.broadcastStateChange();
    return { emailId: result.emailId, threadId: result.threadId };
  }

  // ---------------------------------------------------------------------------------
  // Deferred body parsing (see ./parse-pending.ts)
  // ---------------------------------------------------------------------------------

  private scheduleParseIfPending(delayMs = 0): Promise<void> {
    return scheduleParseIfPending(this.db, this.ctx.storage, delayMs);
  }

  override async alarm(): Promise<void> {
    await parseNextPending({
      db: this.db,
      storage: this.ctx.storage,
      blobs: this.env.BLOBS,
      accountId: () => this.getMeta("accountId"),
      broadcast: () => this.broadcastStateChange(),
    });
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
      const r = insertEmail(this.db, input, {
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
    return acceptSubscription(this.ctx, request, (accountId) => this.init(accountId));
  }

  /** Subscribers are receive-only; incoming messages are ignored. */
  override webSocketMessage(_ws: WebSocket, _message: string | ArrayBuffer): void {}

  override webSocketClose(ws: WebSocket, code: number): void {
    closeSubscriber(ws, code);
  }

  override webSocketError(ws: WebSocket): void {
    errorSubscriber(ws);
  }

  /**
   * Sends the current JMAP StateChange to every connected subscriber. Called after ingest
   * and after a parse; the JMAP write paths added later must call it after committing.
   */
  broadcastStateChange(): void {
    broadcastStateChange(this.ctx, this.getMeta("accountId"), () => this.getState());
  }
}
