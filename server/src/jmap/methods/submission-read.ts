import { z } from "zod";
import type { SubmissionRow } from "../../store/jmap-types";
import type { MethodContext } from "../context";
import { MethodError } from "../errors";
import { LIMITS } from "../types";
import { checkCount, utcDate } from "../util";
import { changesResponse } from "./mailbox";
import { changesArgs, getArgs, parseArgs, pick, propertySet } from "./helpers";

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

export function submissionObject(s: SubmissionRow) {
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

export async function submissionGet(ctx: MethodContext, raw: Record<string, unknown>) {
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

export async function submissionChanges(ctx: MethodContext, raw: Record<string, unknown>) {
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

function filterDate(v: string | undefined): number | undefined {
  if (v === undefined) return undefined;
  const t = Date.parse(v);
  if (Number.isNaN(t)) throw new MethodError("invalidArguments", "Invalid date-time in filter");
  return t;
}

export async function submissionQuery(ctx: MethodContext, raw: Record<string, unknown>) {
  const args = parseArgs(queryArgs, raw);
  const accountId = ctx.account(raw);
  for (const s of args.sort ?? []) {
    if (s.property !== "sentAt" && s.property !== "emailId" && s.property !== "threadId") {
      throw new MethodError("unsupportedSort", `Unsupported sort property "${s.property}"`);
    }
  }
  const f = args.filter ?? {};
  const before = filterDate(f.before);
  const after = filterDate(f.after);
  const r = await ctx.stub(accountId).submissionQuery({
    filter: {
      ...(f.identityIds ? { identityIds: f.identityIds } : {}),
      ...(f.emailIds ? { emailIds: f.emailIds.map((i) => ctx.resolveId(i)) } : {}),
      ...(f.threadIds ? { threadIds: f.threadIds } : {}),
      ...(f.undoStatus ? { undoStatus: f.undoStatus } : {}),
      ...(before !== undefined ? { before } : {}),
      ...(after !== undefined ? { after } : {}),
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
