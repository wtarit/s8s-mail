import { getSendProvider, maxAttachmentBytes } from "../send";
import { loadAccountInfos } from "./context";
import {
  CAP_CORE,
  CAP_MAIL,
  CAP_SUBMISSION,
  LIMITS,
  MAX_MAILBOX_DEPTH,
  MAX_SIZE_MAILBOX_NAME,
  type Principal,
} from "./types";
import { shortHash } from "./util";

/**
 * Per-deployment attachment limit, derived from the active outbound provider (minus MIME
 * overhead). Used for both `maxSizeUpload` and `maxSizeAttachmentsPerEmail` and enforced
 * again on Email/set create and upload.
 */
export function attachmentLimit(env: Env): number {
  try {
    return maxAttachmentBytes(getSendProvider(env));
  } catch {
    return 0;
  }
}

export const EMAIL_QUERY_SORT_OPTIONS = [
  "receivedAt",
  "sentAt",
  "size",
  "from",
  "to",
  "subject",
  // RFC 8621 comparators with a keyword argument; Bulwark uses hasKeyword for pinned-first.
  "hasKeyword",
  "allInThreadHaveKeyword",
  "someInThreadHaveKeyword",
];

/** Session state: changes with the account list or the advertised limits (no D1 read). */
export function sessionState(env: Env, principal: Principal): Promise<string> {
  return shortHash(JSON.stringify({ a: principal.accountIds, l: attachmentLimit(env) }), 8);
}

/** The JMAP Session resource (RFC 8620 §2). */
export async function buildSession(env: Env, principal: Principal) {
  const base = env.PUBLIC_URL.replace(/\/+$/, "");
  const limit = attachmentLimit(env);
  const infos = new Map((await loadAccountInfos(env, principal.accountIds)).map((a) => [a.id, a]));

  const accountCapabilities = {
    [CAP_CORE]: {},
    [CAP_MAIL]: {
      maxMailboxesPerEmail: null,
      maxMailboxDepth: MAX_MAILBOX_DEPTH,
      maxSizeMailboxName: MAX_SIZE_MAILBOX_NAME,
      maxSizeAttachmentsPerEmail: limit,
      emailQuerySortOptions: EMAIL_QUERY_SORT_OPTIONS,
      mayCreateTopLevelMailbox: true,
    },
    [CAP_SUBMISSION]: { maxDelayedSend: 0, submissionExtensions: {} },
  };

  const accounts = Object.fromEntries(
    principal.accountIds.map((id) => [
      id,
      {
        name: infos.get(id)?.name ?? id,
        isPersonal: infos.get(id)?.isPersonal ?? true,
        isReadOnly: false,
        accountCapabilities,
      },
    ]),
  );
  const primary = principal.accountIds[0];
  const capabilities = {
    [CAP_CORE]: {
      maxSizeUpload: limit,
      maxConcurrentUpload: LIMITS.maxConcurrentUpload,
      maxSizeRequest: LIMITS.maxSizeRequest,
      maxConcurrentRequests: LIMITS.maxConcurrentRequests,
      maxCallsInRequest: LIMITS.maxCallsInRequest,
      maxObjectsInGet: LIMITS.maxObjectsInGet,
      maxObjectsInSet: LIMITS.maxObjectsInSet,
      collationAlgorithms: ["i;ascii-casemap", "i;unicode-casemap"],
    },
    [CAP_MAIL]: {},
    [CAP_SUBMISSION]: {},
  };
  const primaryAccounts = primary
    ? { [CAP_MAIL]: primary, [CAP_SUBMISSION]: primary }
    : ({} as Record<string, string>);

  return {
    capabilities,
    accounts,
    primaryAccounts,
    username: principal.email,
    apiUrl: `${base}/jmap/api`,
    downloadUrl: `${base}/jmap/download/{accountId}/{blobId}/{name}?type={type}`,
    uploadUrl: `${base}/jmap/upload/{accountId}/`,
    eventSourceUrl: `${base}/jmap/eventsource?types={types}&closeafter={closeafter}&ping={ping}`,
    state: await sessionState(env, principal),
  };
}
