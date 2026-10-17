import { z } from "zod";
import { getSendProvider } from "../../send";
import type { SendProvider } from "../../send";
import type { MethodContext } from "../context";
import { MethodError } from "../errors";
import { MultiResponse, type MethodDef } from "../registry";
import { CAP_SUBMISSION, LIMITS, type SetError } from "../types";
import { checkCount } from "../util";
import { performEmailSet } from "./email-set";
import { parseArgs } from "./helpers";
import { loadIdentities } from "./identity";
import { createSubmission } from "./submission-create";
import { submissionChanges, submissionGet, submissionQuery } from "./submission-read";

const setArgs = z.object({
  accountId: z.string(),
  ifInState: z.string().nullish(),
  create: z.record(z.string(), z.record(z.string(), z.unknown())).nullish(),
  update: z.record(z.string(), z.record(z.string(), z.unknown())).nullish(),
  destroy: z.array(z.string()).nullish(),
  onSuccessUpdateEmail: z.record(z.string(), z.record(z.string(), z.unknown())).nullish(),
  onSuccessDestroyEmail: z.array(z.string()).nullish(),
});

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
