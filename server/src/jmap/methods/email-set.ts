import { z } from "zod";
import type { EmailUpdateInput } from "../../store/jmap-types";
import type { MethodContext } from "../context";
import { MethodError } from "../errors";
import type { MethodDef } from "../registry";
import { CAP_MAIL, LIMITS, type SetError } from "../types";
import { checkCount } from "../util";
import { createEmail } from "./email-set-create";
import { parseUpdate } from "./email-set-patch";
import { parseArgs } from "./helpers";
import { deleteBlobs } from "./mailbox";

export type EmailSetInput = {
  ifInState?: string | null;
  create?: Record<string, Record<string, unknown>> | null;
  update?: Record<string, Record<string, unknown>> | null;
  destroy?: string[] | null;
};

/** The shared implementation of Email/set, also used for EmailSubmission's implicit calls. */
export async function performEmailSet(
  ctx: MethodContext,
  accountId: string,
  input: EmailSetInput,
): Promise<Record<string, unknown>> {
  const creates = Object.entries(input.create ?? {});
  const updates = Object.entries(input.update ?? {});
  const destroys = (input.destroy ?? []).map((d) => ctx.resolveId(d));
  checkCount(creates.length + updates.length + destroys.length, LIMITS.maxObjectsInSet, "objects");
  const stub = ctx.stub(accountId);
  const before = await stub.getAllStates();
  if (input.ifInState != null && input.ifInState !== before.Email) {
    throw new MethodError("stateMismatch");
  }

  const created: Record<string, unknown> = {};
  const notCreated: Record<string, SetError> = {};
  for (const [cid, obj] of creates) {
    const r = await createEmail(ctx, accountId, obj);
    if ("error" in r) notCreated[cid] = r.error;
    else {
      created[cid] = r.created;
      ctx.createdIds.set(cid, r.created.id as string);
    }
  }

  const updated: Record<string, null> = {};
  const notUpdated: Record<string, SetError> = {};
  const ops: EmailUpdateInput[] = [];
  const opKeys = new Map<string, string>();
  for (const [rawId, patch] of updates) {
    const id = ctx.resolveId(rawId);
    const op = parseUpdate(ctx, id, patch);
    if ("type" in op) notUpdated[rawId] = op;
    else {
      ops.push(op);
      opKeys.set(id, rawId);
    }
  }
  if (ops.length > 0) {
    const r = await stub.emailUpdate(accountId, ops);
    for (const [id, res] of Object.entries(r.results)) {
      const key = opKeys.get(id) ?? id;
      if (res.ok) updated[key] = null;
      else notUpdated[key] = res.error;
    }
  }

  let destroyed: string[] = [];
  const notDestroyed: Record<string, SetError> = {};
  if (destroys.length > 0) {
    const r = await stub.emailDestroy(accountId, destroys);
    destroyed = r.destroyed;
    for (const id of r.notFound) notDestroyed[id] = { type: "notFound" };
    if (r.blobIds.length > 0) await deleteBlobs(ctx.env, accountId, r.blobIds);
  }

  const after = await stub.getAllStates();
  return {
    accountId,
    oldState: before.Email,
    newState: after.Email,
    created: creates.length > 0 ? created : null,
    updated: updates.length > 0 ? updated : null,
    destroyed: destroys.length > 0 ? destroyed : null,
    notCreated: Object.keys(notCreated).length > 0 ? notCreated : null,
    notUpdated: Object.keys(notUpdated).length > 0 ? notUpdated : null,
    notDestroyed: Object.keys(notDestroyed).length > 0 ? notDestroyed : null,
  };
}

const setArgs = z.object({
  accountId: z.string(),
  ifInState: z.string().nullish(),
  create: z.record(z.string(), z.record(z.string(), z.unknown())).nullish(),
  update: z.record(z.string(), z.record(z.string(), z.unknown())).nullish(),
  destroy: z.array(z.string()).nullish(),
});

async function emailSet(ctx: MethodContext, raw: Record<string, unknown>) {
  const args = parseArgs(setArgs, raw);
  const accountId = ctx.account(raw);
  return performEmailSet(ctx, accountId, args);
}

export const emailSetMethods: Record<string, MethodDef> = {
  "Email/set": { capability: CAP_MAIL, handler: emailSet },
};
