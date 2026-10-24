/**
 * JMAP-facing queries and writes against the account DO's SQLite. `AccountDO` exposes thin
 * RPC wrappers around these. Data in/out is plain (see ../jmap-types.ts); the Worker does
 * the JMAP wire formatting.
 *
 * `JmapStore` is a facade; the SQL lives in one module per concern: ./changes.ts,
 * ./mailbox.ts (read), ./mailbox-set.ts (Mailbox/set) with ./mailbox-write.ts (create/update
 * validation), ./email-read.ts, ./email-write.ts and ./submission.ts (EmailSubmission and
 * identity settings).
 *
 * Notes:
 *  - Durable Object SQL allows at most 100 bound parameters per statement, so id lists are
 *    passed as ONE JSON parameter and expanded with `json_each(?)`.
 *  - Every write runs in `transactionSync`. Triggers (drizzle/do/*.sql) maintain change_log.
 */
import type {
  AllStates,
  ChangesResult,
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
} from "../jmap-types";
import { changes } from "./changes";
import { deleteEmails, emailDestroy, emailUpdate } from "./email-write";
import { emailForSubmission, emailGet, emailQuery, snippets, threadGet } from "./email-read";
import { mailboxGet, mailboxIdsExist, mailboxQuery } from "./mailbox";
import { mailboxSet } from "./mailbox-set";
import { StoreSql } from "./sql";
import {
  identitySettings,
  identitySettingsSet,
  submissionCreate,
  submissionDestroy,
  submissionGet,
  submissionQuery,
} from "./submission";

export { MAX_MAILBOX_DEPTH, MAX_MAILBOX_NAME } from "./mailbox-write";

export class JmapStore {
  private readonly sql: StoreSql;

  constructor(storage: DurableObjectStorage) {
    this.sql = new StoreSql(storage);
  }

  state(type: string): string {
    return this.sql.state(type);
  }

  states(): AllStates {
    return this.sql.states();
  }

  changes(type: string, sinceState: string, maxChanges: number): ChangesResult {
    return changes(this.sql, type, sinceState, maxChanges);
  }

  mailboxGet(ids: string[] | null): MailboxGetResult {
    return mailboxGet(this.sql, ids);
  }

  mailboxQuery(p: MailboxQueryParams): MailboxQueryResult {
    return mailboxQuery(this.sql, p);
  }

  /** Caller wraps this in a transaction. Returns blob ids of removed emails. */
  mailboxSet(p: MailboxSetParams): MailboxSetResult {
    return mailboxSet(this.sql, p);
  }

  mailboxIdsExist(ids: string[]): boolean {
    return mailboxIdsExist(this.sql, ids);
  }

  threadGet(ids: string[]): ThreadGetResult {
    return threadGet(this.sql, ids);
  }

  emailGet(ids: string[], withBody: boolean): EmailGetResult {
    return emailGet(this.sql, ids, withBody);
  }

  emailQuery(p: EmailQueryParams): EmailQueryResult {
    return emailQuery(this.sql, p);
  }

  /** FTS snippets for SearchSnippet/get. Markers are U+E000/U+E001 (the Worker escapes + converts). */
  snippets(emailIds: string[], ftsQuery: string | null): SnippetRow[] {
    return snippets(this.sql, emailIds, ftsQuery);
  }

  emailForSubmission(emailId: string): EmailForSubmission | null {
    return emailForSubmission(this.sql, emailId);
  }

  emailUpdate(updates: EmailUpdateInput[]): EmailUpdateResult {
    return emailUpdate(this.sql, updates);
  }

  /** Deletes emails (rows, membership, keywords); returns the R2 blob ids to remove. */
  deleteEmails(ids: string[]): { destroyed: string[]; blobIds: string[] } {
    return deleteEmails(this.sql, ids);
  }

  emailDestroy(ids: string[]): EmailDestroyResult {
    return emailDestroy(this.sql, ids);
  }

  identitySettings(): IdentitySettingRow[] {
    return identitySettings(this.sql);
  }

  identitySettingsSet(address: string, update: IdentitySettingUpdate): void {
    identitySettingsSet(this.sql, address, update);
  }

  submissionCreate(input: SubmissionCreateInput): SubmissionRow {
    return submissionCreate(this.sql, input);
  }

  submissionGet(ids: string[] | null): ReturnType<typeof submissionGet> {
    return submissionGet(this.sql, ids);
  }

  submissionQuery(p: SubmissionQueryParams): ReturnType<typeof submissionQuery> {
    return submissionQuery(this.sql, p);
  }

  submissionDestroy(ids: string[]): ReturnType<typeof submissionDestroy> {
    return submissionDestroy(this.sql, ids);
  }
}
