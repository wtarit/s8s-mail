import type { MethodContext } from "../context";
import type { MethodDef } from "../registry";
import { CAP_MAIL, LIMITS } from "../types";
import { checkCount } from "../util";
import { changesArgs, getArgs, parseArgs } from "./helpers";
import { changesResponse } from "./mailbox";

async function threadGet(ctx: MethodContext, raw: Record<string, unknown>) {
  const args = parseArgs(getArgs, raw);
  const accountId = ctx.account(raw);
  const ids = args.ids ?? [];
  checkCount(ids.length, LIMITS.maxObjectsInGet, "ids");
  const r = await ctx.stub(accountId).threadGet(ids);
  return { accountId, state: r.state, list: r.list, notFound: r.notFound };
}

async function threadChanges(ctx: MethodContext, raw: Record<string, unknown>) {
  const args = parseArgs(changesArgs, raw);
  const accountId = ctx.account(raw);
  return changesResponse(ctx, accountId, "Thread", args.sinceState, args.maxChanges);
}

export const threadMethods: Record<string, MethodDef> = {
  "Thread/get": { capability: CAP_MAIL, handler: threadGet },
  "Thread/changes": { capability: CAP_MAIL, handler: threadChanges },
};
