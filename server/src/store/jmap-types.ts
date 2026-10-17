/**
 * Plain-data types exchanged between the JMAP layer (stateless Worker) and the account DO
 * over RPC. Everything here must be structured-clone friendly (no classes, no functions).
 * The DO knows nothing about JMAP wire format (no ISO dates, no property filtering); the
 * Worker formats. Errors the client should see are returned as values, not thrown.
 */
import type { DeliveryStatus } from "./schema";
import type { BodyPart, EmailAddress } from "./types";

export type { DeliveryStatus };

/** A JMAP-style error returned as a value (method error or per-object SetError). */
export type StoreError = { type: string; description?: string; properties?: string[] };

/** All JMAP state strings of the account. */
export type AllStates = {
  Email: string;
  Mailbox: string;
  Thread: string;
  EmailSubmission: string;
  Identity: string;
};

export type ChangesResult =
  | {
      ok: true;
      oldState: string;
      newState: string;
      hasMoreChanges: boolean;
      created: string[];
      updated: string[];
      destroyed: string[];
      /** Mailbox/changes only: set when every updated mailbox only had its counts change. */
      updatedProperties: string[] | null;
    }
  | { ok: false; error: StoreError };

// --- Mailbox ---------------------------------------------------------------------------

export type MailboxRow = {
  id: string;
  name: string;
  parentId: string | null;
  role: string | null;
  sortOrder: number;
  isSubscribed: boolean;
  totalEmails: number;
  unreadEmails: number;
  totalThreads: number;
  unreadThreads: number;
};

export type MailboxGetResult = { state: string; list: MailboxRow[]; notFound: string[] };

export type MailboxQueryParams = {
  filter: {
    parentId?: string | null;
    name?: string;
    role?: string | null;
    hasAnyRole?: boolean;
    isSubscribed?: boolean;
  };
  sort: { property: "sortOrder" | "name"; isAscending: boolean }[];
  position: number;
  limit: number | null;
};

export type MailboxQueryResult = {
  queryState: string;
  ids: string[];
  total: number;
  position: number;
};

export type MailboxCreateInput = {
  key: string;
  name: string;
  /** Existing mailbox id, `#key` of another create in the same call, or null. */
  parentId: string | null;
  role: string | null;
  sortOrder: number;
  isSubscribed: boolean;
};

export type MailboxUpdateInput = {
  id: string;
  name?: string;
  parentId?: string | null;
  role?: string | null;
  sortOrder?: number;
  isSubscribed?: boolean;
};

export type MailboxSetParams = {
  accountId: string;
  ifInState: string | null;
  create: MailboxCreateInput[];
  update: MailboxUpdateInput[];
  destroy: string[];
  onDestroyRemoveEmails: boolean;
};

export type MailboxSetResult =
  | {
      ok: true;
      oldState: string;
      newState: string;
      created: Record<string, MailboxRow>;
      notCreated: Record<string, StoreError>;
      updated: string[];
      notUpdated: Record<string, StoreError>;
      destroyed: string[];
      notDestroyed: Record<string, StoreError>;
      /** R2 blob ids (raw + parts) of emails removed by onDestroyRemoveEmails. */
      removedBlobIds: string[];
    }
  | { ok: false; error: StoreError };

// --- Thread ----------------------------------------------------------------------------

export type ThreadGetResult = {
  state: string;
  list: { id: string; emailIds: string[] }[];
  notFound: string[];
};

// --- Email -----------------------------------------------------------------------------

export type EmailRow = {
  id: string;
  blobId: string;
  threadId: string;
  size: number;
  /** ms since epoch */
  receivedAt: number;
  sentAt: number | null;
  messageId: string | null;
  inReplyTo: string[] | null;
  references: string[] | null;
  subject: string | null;
  from: EmailAddress[] | null;
  sender: EmailAddress[] | null;
  to: EmailAddress[] | null;
  cc: EmailAddress[] | null;
  bcc: EmailAddress[] | null;
  replyTo: EmailAddress[] | null;
  preview: string;
  hasAttachment: boolean;
  parseState: "pending" | "parsed" | "failed";
  mailboxIds: string[];
  keywords: string[];
  /** Present only when requested (`withBody`). */
  bodyStructure?: BodyPart | null;
  textBody?: BodyPart[] | null;
  htmlBody?: BodyPart[] | null;
  attachments?: BodyPart[] | null;
};

export type EmailGetResult = { state: string; rows: EmailRow[]; notFound: string[] };

/** FilterCondition properties of RFC 8621 §4.4.1 (validated by the Worker). */
export type EmailCondition = {
  inMailbox?: string;
  inMailboxOtherThan?: string[];
  /** ms since epoch */
  before?: number;
  after?: number;
  minSize?: number;
  maxSize?: number;
  allInThreadHaveKeyword?: string;
  someInThreadHaveKeyword?: string;
  noneInThreadHaveKeyword?: string;
  hasKeyword?: string;
  notKeyword?: string;
  hasAttachment?: boolean;
  text?: string;
  from?: string;
  to?: string;
  cc?: string;
  bcc?: string;
  subject?: string;
  body?: string;
  header?: string[];
};

export type EmailFilter =
  | EmailCondition
  | { operator: "AND" | "OR" | "NOT"; conditions: EmailFilter[] };

export type EmailSort = { property: string; isAscending: boolean; keyword?: string };

export type EmailQueryParams = {
  filter: EmailFilter | null;
  sort: EmailSort[];
  position: number;
  anchor: string | null;
  anchorOffset: number;
  limit: number | null;
  collapseThreads: boolean;
  calculateTotal: boolean;
};

export type EmailQueryResult =
  | {
      ok: true;
      queryState: string;
      ids: string[];
      position: number;
      total: number | null;
    }
  | { ok: false; error: StoreError };

export type EmailCreateInput = {
  accountId: string;
  /** Raw RFC 5322 message already stored in R2 (`${accountId}/${blobId}`). */
  blobId: string;
  size: number;
  receivedAt: number;
  headers: {
    messageId: string | null;
    inReplyTo: string[];
    references: string[];
    subject: string | null;
    sentAt: number | null;
    from: EmailAddress[];
    sender: EmailAddress[];
    to: EmailAddress[];
    cc: EmailAddress[];
    bcc: EmailAddress[];
    replyTo: EmailAddress[];
  };
  mailboxIds: string[];
  keywords: string[];
};

export type EmailCreateResult =
  | { ok: true; emailId: string; threadId: string }
  | { ok: false; error: StoreError };

export type SetOp = { set?: string[]; add?: string[]; remove?: string[] };

export type EmailUpdateInput = { id: string; keywords?: SetOp; mailboxIds?: SetOp };

export type EmailUpdateResult = {
  oldState: string;
  newState: string;
  results: Record<string, { ok: true } | { ok: false; error: StoreError }>;
};

export type EmailDestroyResult = {
  oldState: string;
  newState: string;
  destroyed: string[];
  notFound: string[];
  /** R2 blob ids (raw message and decoded parts) to delete. */
  blobIds: string[];
};

export type SnippetRow = { emailId: string; subject: string | null; preview: string | null };

// --- Identity --------------------------------------------------------------------------

export type IdentitySettingRow = {
  address: string;
  name: string | null;
  replyTo: EmailAddress[] | null;
  bcc: EmailAddress[] | null;
  textSignature: string | null;
  htmlSignature: string | null;
};

export type IdentitySettingUpdate = Partial<Omit<IdentitySettingRow, "address">>;

// --- EmailSubmission -------------------------------------------------------------------

export type SubmissionRow = {
  id: string;
  identityId: string;
  emailId: string;
  threadId: string;
  envelopeMailFrom: string;
  envelopeRcptTo: string[];
  sendAt: number;
  undoStatus: "pending" | "final" | "canceled";
  deliveryStatus: Record<string, DeliveryStatus> | null;
};

export type SubmissionCreateInput = Omit<SubmissionRow, "id"> & {
  accountId: string;
  providerMessageId: string | null;
};

/** The few Email fields EmailSubmission/set needs. */
export type EmailForSubmission = {
  id: string;
  blobId: string;
  threadId: string;
  size: number;
  from: EmailAddress[];
  sender: EmailAddress[];
  to: EmailAddress[];
  cc: EmailAddress[];
  bcc: EmailAddress[];
  /** Sum of attachment sizes if the body was parsed, else null. */
  attachmentBytes: number | null;
};

export type SubmissionQueryParams = {
  filter: {
    identityIds?: string[];
    emailIds?: string[];
    threadIds?: string[];
    undoStatus?: string;
    before?: number;
    after?: number;
  };
  sortAscending: boolean;
  position: number;
  limit: number | null;
};
