/** Shared JMAP types and constants (RFC 8620 core, RFC 8621 mail + submission). */
import type { AccountDO } from "../store/account-do";

/** Set on the request context by the auth middleware (`jmapAuth`). */
export type { Principal } from "../auth/types";
import type { Principal } from "../auth/types";

/** Hono environment for the JMAP sub-app. */
export type JmapEnv = { Bindings: Env; Variables: { principal: Principal } };

export const CAP_CORE = "urn:ietf:params:jmap:core";
export const CAP_MAIL = "urn:ietf:params:jmap:mail";
export const CAP_SUBMISSION = "urn:ietf:params:jmap:submission";
/** Capabilities this server advertises and accepts in `using`. Never urn:stalwart:jmap. */
export const SUPPORTED_CAPABILITIES = [CAP_CORE, CAP_MAIL, CAP_SUBMISSION] as const;

/** Core capability limits (RFC 8620 §2). maxSizeUpload is added per deployment (provider). */
export const LIMITS = {
  maxConcurrentUpload: 4,
  maxSizeRequest: 10_000_000,
  maxConcurrentRequests: 4,
  maxCallsInRequest: 32,
  maxObjectsInGet: 256,
  maxObjectsInSet: 128,
} as const;

export const MAX_MAILBOX_DEPTH = 10;
export const MAX_SIZE_MAILBOX_NAME = 255;

/** [method name, arguments, call id] */
export type Invocation = [string, Record<string, unknown>, string];

export type SetError = {
  type: string;
  description?: string;
  properties?: string[];
  [extra: string]: unknown;
};

export type AccountStub = DurableObjectStub<AccountDO>;

export type AddressRow = { address: string; kind: "primary" | "alias" };
export type AccountInfo = { id: string; name: string; isPersonal: boolean };
