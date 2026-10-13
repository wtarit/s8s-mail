import { z } from "zod";
import { normalizeRecipient } from "../../mail/headers";
import { envelopeFromEmail, removeBccHeader } from "../../mime";
import { SendError, getSendProvider } from "../../send";
import type { SendProvider } from "../../send";
import { blobKey } from "../../store/blob";
import type { DeliveryStatus, SubmissionRow } from "../../store/jmap-types";
import type { MethodContext } from "../context";
import { MethodError } from "../errors";
import { MultiResponse, type MethodDef } from "../registry";
import { attachmentLimit } from "../session";
import { CAP_SUBMISSION, LIMITS, type SetError } from "../types";
import { checkCount, utcDate } from "../util";
import { performEmailSet } from "./email-set";
import { changesResponse } from "./mailbox";
import { changesArgs, getArgs, parseArgs, pick, propertySet } from "./helpers";
import { loadIdentities } from "./identity";

const SUBMISSION_PROPERTIES = new Set([
  "id",
  "identityId",
  "emailId",
  "threadId",
  "envelope",
  "sendAt",
  "undoStatus",
  "deliveryStatus",
  "dsnBlobIds",
  "mdnBlobIds",
]);

function submissionObject(s: SubmissionRow) {
  return {
    id: s.id,
    identityId: s.identityId,
    emailId: s.emailId,
    threadId: s.threadId,
    envelope: {
      mailFrom: { email: s.envelopeMailFrom, parameters: null },
      rcptTo: s.envelopeRcptTo.map((email) => ({ email, parameters: null })),
    },
    sendAt: utcDate(s.sendAt),
    undoStatus: s.undoStatus,
    deliveryStatus: s.deliveryStatus,
    dsnBlobIds: [] as string[],
    mdnBlobIds: [] as string[],
  };
}

async function submissionGet(ctx: MethodContext, raw: Record<string, unknown>) {
  const args = parseArgs(getArgs, raw);
  const accountId = ctx.account(raw);
  const props = propertySet(args.properties, SUBMISSION_PROPERTIES);
  if (args.ids) checkCount(args.ids.length, LIMITS.maxObjectsInGet, "ids");
  const r = await ctx
    .stub(accountId)
    .submissionGet(args.ids ? args.ids.map((i) => ctx.resolveId(i)) : null);
  return {
    accountId,
    state: r.state,
    list: r.list.map((s) => pick(submissionObject(s), props)),
    notFound: r.notFound,
  };
}

async function submissionChanges(ctx: MethodContext, raw: Record<string, unknown>) {
  const args = parseArgs(changesArgs, raw);
  const accountId = ctx.account(raw);
  return changesResponse(ctx, accountId, "EmailSubmission", args.sinceState, args.maxChanges);
}

const queryArgs = z.object({
  accountId: z.string(),
  filter: z
    .object({
      identityIds: z.array(z.string()).optional(),
      emailIds: z.array(z.string()).optional(),
      threadIds: z.array(z.string()).optional(),
      undoStatus: z.string().optional(),
      before: z.string().optional(),
      after: z.string().optional(),
    })
    .nullish(),
  sort: z.array(z.object({ property: z.string(), isAscending: z.boolean().optional() })).nullish(),
  position: z.number().int().min(0).optional(),
  limit: z.number().int().min(0).nullish(),
  calculateTotal: z.boolean().optional(),
});

async function submissionQuery(ctx: MethodContext, raw: Record<string, unknown>) {
  const args = parseArgs(queryArgs, raw);
  const accountId = ctx.account(raw);
  for (const s of args.sort ?? []) {
    if (s.property !== "sentAt" && s.property !== "emailId" && s.property !== "threadId") {
      throw new MethodError("unsupportedSort", `Unsupported sort property "${s.property}"`);
    }
  }
  const f = args.filter ?? {};
  const date = (v: string | undefined) => {
    if (v === undefined) return {};
    const t = Date.parse(v);
    if (Number.isNaN(t)) throw new MethodError("invalidArguments", "Invalid date-time in filter");
    return t;
  };
  const before = date(f.before);
  const after = date(f.after);
  const r = await ctx.stub(accountId).submissionQuery({
    filter: {
      ...(f.identityIds ? { identityIds: f.identityIds } : {}),
      ...(f.emailIds ? { emailIds: f.emailIds.map((i) => ctx.resolveId(i)) } : {}),
      ...(f.threadIds ? { threadIds: f.threadIds } : {}),
      ...(f.undoStatus ? { undoStatus: f.undoStatus } : {}),
      ...(typeof before === "number" ? { before } : {}),
      ...(typeof after === "number" ? { after } : {}),
    },
    sortAscending: args.sort?.[0]?.isAscending ?? true,
    position: args.position ?? 0,
    limit: args.limit ?? null,
  });
  return {
    accountId,
    queryState: r.queryState,
    canCalculateChanges: false,
    position: r.position,
    ids: r.ids,
    ...(args.calculateTotal ? { total: r.total } : {}),
  };
}

const createSchema = z.object({
  emailId: z.string(),
  identityId: z.string(),
  envelope: z
    .object({
      mailFrom: z.object({ email: z.string(), parameters: z.unknown().optional() }),
      rcptTo: z.array(z.object({ email: z.string(), parameters: z.unknown().optional() })),
    })
    .nullish(),
  undoStatus: z.string().optional(),
});

const setArgs = z.object({
  accountId: z.string(),
  ifInState: z.string().nullish(),
  create: z.record(z.string(), z.record(z.string(), z.unknown())).nullish(),
  update: z.record(z.string(), z.record(z.string(), z.unknown())).nullish(),
  destroy: z.array(z.string()).nullish(),
  onSuccessUpdateEmail: z.record(z.string(), z.record(z.string(), z.unknown())).nullish(),
  onSuccessDestroyEmail: z.array(z.string()).nullish(),
});

const ADDR_RE = /^[^\s@<>]+@[^\s@<>]+$/;

/** Maps a provider failure to a SetError. Retries/queueing are out of scope (see README). */
export function sendErrorToSetError(err: SendError, provider: SendProvider): SetError {
  const code = err.code ?? "";
  if (err.retryable) {
    return { type: "serverFail", description: `The provider is unavailable: ${err.message}` };
  }
  if (code === "tooLarge" || code.endsWith("_413")) {
    return { type: "tooLarge", description: err.message, maxSize: provider.maxMessageBytes };
  }
  if (code === "tooManyRecipients") {
    return {
      type: "tooManyRecipients",
      description: err.message,
      maxRecipients: provider.maxRecipients,
    };
  }
  if (code === "noRecipients") return { type: "noRecipients", description: err.message };
  if (code.endsWith("_400") || code.endsWith("_422")) {
    return { type: "invalidEmail", description: err.message };
  }
  if (code === "notConfigured") return { type: "serverFail", description: err.message };
  return { type: "forbiddenToSend", description: err.message };
}

type Created = { object: Record<string, unknown>; emailId: string };

async function createSubmission(
  ctx: MethodContext,
  accountId: string,
  obj: Record<string, unknown>,
  provider: SendProvider,
  identities: Awaited<ReturnType<typeof loadIdentities>>["list"],
  accountAddresses: Set<string>,
): Promise<{ ok: Created } | { error: SetError }> {
  const parsed = createSchema.safeParse(obj);
  if (!parsed.success) {
    return {
      error: {
        type: "invalidProperties",
        properties: [...new Set(parsed.error.issues.map((i) => String(i.path[0])))],
      },
    };
  }
  const c = parsed.data;
  const emailId = ctx.resolveId(c.emailId);
  const identity = identities.find((i) => i.id === ctx.resolveId(c.identityId));
  if (!identity) {
    return {
      error: {
        type: "invalidProperties",
        properties: ["identityId"],
        description: "Unknown identity",
      },
    };
  }
  const stub = ctx.stub(accountId);
  const email = await stub.emailForSubmission(emailId);
  if (!email) {
    return {
      error: { type: "invalidProperties", properties: ["emailId"], description: "Unknown email" },
    };
  }

  // The From address(es) must be the chosen identity's address (plus-tags ignored).
  if (
    email.from.length === 0 ||
    email.from.some((f) => normalizeRecipient(f.email) !== identity.email)
  ) {
    return {
      error: {
        type: "forbiddenFrom",
        description: `The From address does not match the identity ${identity.email}`,
      },
    };
  }

  let mailFrom: string;
  let rcptTo: string[];
  try {
    if (c.envelope) {
      mailFrom = c.envelope.mailFrom.email.trim();
      rcptTo = [...new Set(c.envelope.rcptTo.map((r) => r.email.trim()))];
    } else {
      ({ mailFrom, rcptTo } = envelopeFromEmail(email));
    }
  } catch (err) {
    return {
      error: {
        type: "invalidEmail",
        description: err instanceof Error ? err.message : "Invalid email",
      },
    };
  }
  if (!ADDR_RE.test(mailFrom) || rcptTo.some((r) => !ADDR_RE.test(r))) {
    return {
      error: {
        type: "invalidProperties",
        properties: ["envelope"],
        description: "Invalid address in envelope",
      },
    };
  }
  if (!accountAddresses.has(normalizeRecipient(mailFrom))) {
    return {
      error: {
        type: "forbiddenMailFrom",
        description: "The envelope MAIL FROM must be one of your addresses",
      },
    };
  }
  if (rcptTo.length === 0) return { error: { type: "noRecipients" } };
  if (rcptTo.length > provider.maxRecipients) {
    return {
      error: {
        type: "tooManyRecipients",
        description: `At most ${provider.maxRecipients} recipients`,
        maxRecipients: provider.maxRecipients,
      },
    };
  }
  const limit = attachmentLimit(ctx.env);
  if (email.size > provider.maxMessageBytes || (email.attachmentBytes ?? 0) > limit) {
    return {
      error: {
        type: "tooLarge",
        description: `The message exceeds the sending limit (attachments up to ${limit} bytes)`,
        maxSize: provider.maxMessageBytes,
      },
    };
  }

  const obj2 = await ctx.env.BLOBS.get(blobKey(accountId, email.blobId));
  if (!obj2)
    return { error: { type: "serverFail", description: "The message content is missing" } };
  const raw = removeBccHeader(new Uint8Array(await obj2.arrayBuffer()));

  let providerMessageId: string | null = null;
  try {
    const sent = await provider.send({ mailFrom, rcptTo, raw });
    providerMessageId = sent.providerMessageId ?? null;
  } catch (err) {
    if (err instanceof SendError) return { error: sendErrorToSetError(err, provider) };
    throw err;
  }

  const deliveryStatus: Record<string, DeliveryStatus> = Object.fromEntries(
    rcptTo.map((r) => [
      r,
      {
        smtpReply: "250 2.0.0 Accepted by the sending provider",
        delivered: "queued",
        displayed: "unknown",
      },
    ]),
  );
  const row = await stub.submissionCreate({
    accountId,
    identityId: identity.id,
    emailId,
    threadId: email.threadId,
    envelopeMailFrom: mailFrom,
    envelopeRcptTo: rcptTo,
    sendAt: Date.now(),
    undoStatus: "final",
    deliveryStatus,
    providerMessageId,
  });
  const o = submissionObject(row);
  return {
    ok: {
      emailId,
      object: {
        id: o.id,
        threadId: o.threadId,
        sendAt: o.sendAt,
        undoStatus: o.undoStatus,
        deliveryStatus: o.deliveryStatus,
        dsnBlobIds: [],
        mdnBlobIds: [],
        ...(c.envelope ? {} : { envelope: o.envelope }),
      },
    },
  };
}

/**
 * EmailSubmission/set (RFC 8621 §7.5). Sending is synchronous through the deployment's
 * provider: there is no queue, no retry and no undo (undoStatus is always "final"); a
 * retryable provider failure is reported as a `serverFail` SetError and the client retries.
 */
async function submissionSet(ctx: MethodContext, raw: Record<string, unknown>) {
  const args = parseArgs(setArgs, raw);
  const accountId = ctx.account(raw);
  const creates = Object.entries(args.create ?? {});
  checkCount(
    creates.length + Object.keys(args.update ?? {}).length + (args.destroy?.length ?? 0),
    LIMITS.maxObjectsInSet,
    "objects",
  );
  const stub = ctx.stub(accountId);
  const before = await stub.getAllStates();
  if (args.ifInState != null && args.ifInState !== before.EmailSubmission) {
    throw new MethodError("stateMismatch");
  }
  let provider: SendProvider;
  try {
    provider = getSendProvider(ctx.env);
  } catch (err) {
    throw new MethodError("serverFail", err instanceof Error ? err.message : "No send provider");
  }

  const created: Record<string, unknown> = {};
  const notCreated: Record<string, SetError> = {};
  const sentEmail = new Map<string, string>(); // creation id -> email id
  if (creates.length > 0) {
    const { list: identities } = await loadIdentities(ctx, accountId);
    const addrs = new Set((await ctx.accountAddresses(accountId)).map((a) => a.address));
    for (const [cid, obj] of creates) {
      const r = await createSubmission(ctx, accountId, obj, provider, identities, addrs);
      if ("error" in r) notCreated[cid] = r.error;
      else {
        created[cid] = r.ok.object;
        sentEmail.set(cid, r.ok.emailId);
        ctx.createdIds.set(cid, r.ok.object.id as string);
      }
    }
  }

  const updated: Record<string, null> = {};
  const notUpdated: Record<string, SetError> = {};
  for (const [id, patch] of Object.entries(args.update ?? {})) {
    notUpdated[id] =
      patch.undoStatus === "canceled"
        ? { type: "cannotUnsendMessage", description: "Messages are sent immediately" }
        : { type: "invalidProperties", properties: Object.keys(patch), description: "Immutable" };
  }
  let destroyed: string[] = [];
  const notDestroyed: Record<string, SetError> = {};
  if (args.destroy?.length) {
    const r = await stub.submissionDestroy(
      accountId,
      args.destroy.map((d) => ctx.resolveId(d)),
    );
    destroyed = r.destroyed;
    for (const id of r.notFound) notDestroyed[id] = { type: "notFound" };
  }
  const after = await stub.getAllStates();
  const primary = {
    accountId,
    oldState: before.EmailSubmission,
    newState: after.EmailSubmission,
    created: creates.length > 0 ? created : null,
    updated: Object.keys(updated).length > 0 ? updated : null,
    destroyed: args.destroy?.length ? destroyed : null,
    notCreated: Object.keys(notCreated).length > 0 ? notCreated : null,
    notUpdated: Object.keys(notUpdated).length > 0 ? notUpdated : null,
    notDestroyed: Object.keys(notDestroyed).length > 0 ? notDestroyed : null,
  };

  // Implicit Email/set for the successfully sent messages.
  const target = (key: string): string | null => {
    if (key.startsWith("#")) return sentEmail.get(key.slice(1)) ?? null;
    return [...sentEmail.values()].includes(key) ? key : null;
  };
  const update: Record<string, Record<string, unknown>> = {};
  for (const [key, patch] of Object.entries(args.onSuccessUpdateEmail ?? {})) {
    const emailId = target(key);
    if (emailId) update[emailId] = patch;
  }
  const destroy = (args.onSuccessDestroyEmail ?? [])
    .map(target)
    .filter((x): x is string => x !== null);
  if (Object.keys(update).length === 0 && destroy.length === 0) return primary;
  const emailSet = await performEmailSet(ctx, accountId, {
    update: Object.keys(update).length > 0 ? update : null,
    destroy: destroy.length > 0 ? destroy : null,
  });
  return new MultiResponse([
    ["EmailSubmission/set", primary],
    ["Email/set", emailSet],
  ]);
}

export const submissionMethods: Record<string, MethodDef> = {
  "EmailSubmission/get": { capability: CAP_SUBMISSION, handler: submissionGet },
  "EmailSubmission/changes": { capability: CAP_SUBMISSION, handler: submissionChanges },
  "EmailSubmission/query": { capability: CAP_SUBMISSION, handler: submissionQuery },
  "EmailSubmission/queryChanges": {
    capability: CAP_SUBMISSION,
    handler: async () => {
      throw new MethodError("cannotCalculateChanges", "queryChanges is not supported");
    },
  },
  "EmailSubmission/set": { capability: CAP_SUBMISSION, handler: submissionSet },
};
