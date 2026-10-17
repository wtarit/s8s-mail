import { z } from "zod";
import { MethodError } from "../errors";
import type { MailboxRow } from "../../store/jmap-types";
import type { MethodContext } from "../context";
import type { MethodDef } from "../registry";
import { errorFields } from "../../log";
import { CAP_MAIL, LIMITS, type SetError } from "../types";
import { checkCount } from "../util";
import { changesArgs, getArgs, parseArgs, pick, propertySet } from "./helpers";

const MAILBOX_PROPERTIES = new Set([
  "id",
  "name",
  "parentId",
  "role",
  "sortOrder",
  "totalEmails",
  "unreadEmails",
  "totalThreads",
  "unreadThreads",
  "myRights",
  "isSubscribed",
]);

const MY_RIGHTS = {
  mayReadItems: true,
  mayAddItems: true,
  mayRemoveItems: true,
  maySetSeen: true,
  maySetKeywords: true,
  mayCreateChild: true,
  mayRename: true,
  mayDelete: true,
  maySubmit: true,
};

export function mailboxObject(m: MailboxRow) {
  return {
    id: m.id,
    name: m.name,
    parentId: m.parentId,
    role: m.role,
    sortOrder: m.sortOrder,
    totalEmails: m.totalEmails,
    unreadEmails: m.unreadEmails,
    totalThreads: m.totalThreads,
    unreadThreads: m.unreadThreads,
    myRights: MY_RIGHTS,
    isSubscribed: m.isSubscribed,
  };
}

async function mailboxGet(ctx: MethodContext, raw: Record<string, unknown>) {
  const args = parseArgs(getArgs, raw);
  const accountId = ctx.account(raw);
  const props = propertySet(args.properties, MAILBOX_PROPERTIES);
  if (args.ids) checkCount(args.ids.length, LIMITS.maxObjectsInGet, "ids");
  const ids = args.ids ? args.ids.map((i) => ctx.resolveId(i)) : null;
  const r = await ctx.stub(accountId).mailboxGet(ids);
  return {
    accountId,
    state: r.state,
    list: r.list.map((m) => pick(mailboxObject(m), props)),
    notFound: r.notFound,
  };
}

async function mailboxChanges(ctx: MethodContext, raw: Record<string, unknown>) {
  const args = parseArgs(changesArgs, raw);
  const accountId = ctx.account(raw);
  return changesResponse(ctx, accountId, "Mailbox", args.sinceState, args.maxChanges);
}

export async function changesResponse(
  ctx: MethodContext,
  accountId: string,
  type: string,
  sinceState: string,
  maxChanges: number | null | undefined,
) {
  const r = await ctx
    .stub(accountId)
    .getChanges(type, sinceState, Math.min(maxChanges ?? 512, 512));
  if (!r.ok) throw new MethodError(r.error.type, r.error.description);
  return {
    accountId,
    oldState: r.oldState,
    newState: r.newState,
    hasMoreChanges: r.hasMoreChanges,
    ...(type === "Mailbox" ? { updatedProperties: r.updatedProperties } : {}),
    created: r.created,
    updated: r.updated,
    destroyed: r.destroyed,
  };
}

const mailboxQueryArgs = z.object({
  accountId: z.string(),
  filter: z
    .object({
      parentId: z.string().nullable().optional(),
      name: z.string().optional(),
      role: z.string().nullable().optional(),
      hasAnyRole: z.boolean().optional(),
      isSubscribed: z.boolean().optional(),
    })
    .nullable()
    .optional(),
  sort: z
    .array(z.object({ property: z.string(), isAscending: z.boolean().optional() }))
    .nullable()
    .optional(),
  position: z.number().int().optional(),
  limit: z.number().int().min(0).nullable().optional(),
  calculateTotal: z.boolean().optional(),
  sortAsTree: z.boolean().optional(),
  filterAsTree: z.boolean().optional(),
});

async function mailboxQuery(ctx: MethodContext, raw: Record<string, unknown>) {
  const args = parseArgs(mailboxQueryArgs, raw);
  const accountId = ctx.account(raw);
  if (args.sortAsTree || args.filterAsTree) {
    throw new MethodError("invalidArguments", "sortAsTree/filterAsTree are not supported");
  }
  const sort: { property: "sortOrder" | "name"; isAscending: boolean }[] = [];
  for (const s of args.sort ?? []) {
    if (s.property !== "sortOrder" && s.property !== "name") {
      throw new MethodError("unsupportedSort", `Unsupported sort property "${s.property}"`);
    }
    sort.push({ property: s.property, isAscending: s.isAscending ?? true });
  }
  const filter = { ...args.filter };
  if (filter.parentId) filter.parentId = ctx.resolveId(filter.parentId);
  const r = await ctx.stub(accountId).mailboxQuery({
    filter: filter as never,
    sort,
    position: Math.max(0, args.position ?? 0),
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
  name: z.string(),
  parentId: z.string().nullable().optional(),
  role: z.string().nullable().optional(),
  sortOrder: z.number().int().min(0).optional(),
  isSubscribed: z.boolean().optional(),
});
const updateSchema = createSchema.partial();
const READ_ONLY = new Set([
  "id",
  "totalEmails",
  "unreadEmails",
  "totalThreads",
  "unreadThreads",
  "myRights",
]);

const setArgs = z.object({
  accountId: z.string(),
  ifInState: z.string().nullable().optional(),
  create: z.record(z.string(), z.record(z.string(), z.unknown())).nullable().optional(),
  update: z.record(z.string(), z.record(z.string(), z.unknown())).nullable().optional(),
  destroy: z.array(z.string()).nullable().optional(),
  onDestroyRemoveEmails: z.boolean().optional(),
});

function checkProps(obj: Record<string, unknown>): SetError | null {
  const bad = Object.keys(obj).filter(
    (k) =>
      READ_ONLY.has(k) || !["name", "parentId", "role", "sortOrder", "isSubscribed"].includes(k),
  );
  return bad.length > 0
    ? { type: "invalidProperties", properties: bad, description: "Unknown or read-only property" }
    : null;
}

async function mailboxSet(ctx: MethodContext, raw: Record<string, unknown>) {
  const args = parseArgs(setArgs, raw);
  const accountId = ctx.account(raw);
  const creates = Object.entries(args.create ?? {});
  const updates = Object.entries(args.update ?? {});
  const destroys = args.destroy ?? [];
  checkCount(creates.length + updates.length + destroys.length, LIMITS.maxObjectsInSet, "objects");

  const notCreated: Record<string, SetError> = {};
  const notUpdated: Record<string, SetError> = {};
  const createInputs = [];
  const createKeys = new Set(creates.map(([k]) => k));
  for (const [key, obj] of creates) {
    const bad = checkProps(obj);
    const parsed = createSchema.safeParse(obj);
    if (bad || !parsed.success) {
      notCreated[key] = bad ?? {
        type: "invalidProperties",
        properties: parsed.success ? [] : parsed.error.issues.map((i) => String(i.path[0])),
      };
      continue;
    }
    let parentId = parsed.data.parentId ?? null;
    if (parentId?.startsWith("#") && !createKeys.has(parentId.slice(1))) {
      parentId = ctx.resolveId(parentId);
    }
    createInputs.push({
      key,
      name: parsed.data.name,
      parentId,
      role: parsed.data.role ?? null,
      sortOrder: parsed.data.sortOrder ?? 0,
      isSubscribed: parsed.data.isSubscribed ?? true,
    });
  }
  const updateInputs = [];
  for (const [rawId, obj] of updates) {
    const id = ctx.resolveId(rawId);
    const bad = checkProps(obj);
    const parsed = updateSchema.safeParse(obj);
    if (bad || !parsed.success) {
      notUpdated[rawId] = bad ?? {
        type: "invalidProperties",
        properties: parsed.success ? [] : parsed.error.issues.map((i) => String(i.path[0])),
      };
      continue;
    }
    const d = parsed.data;
    updateInputs.push({
      id,
      ...(d.name !== undefined ? { name: d.name } : {}),
      ...(d.parentId !== undefined
        ? { parentId: d.parentId ? ctx.resolveId(d.parentId) : null }
        : {}),
      ...(d.role !== undefined ? { role: d.role } : {}),
      ...(d.sortOrder !== undefined ? { sortOrder: d.sortOrder } : {}),
      ...(d.isSubscribed !== undefined ? { isSubscribed: d.isSubscribed } : {}),
    });
  }

  const r = await ctx.stub(accountId).mailboxSet({
    accountId,
    ifInState: args.ifInState ?? null,
    create: createInputs,
    update: updateInputs,
    destroy: destroys.map((d) => ctx.resolveId(d)),
    onDestroyRemoveEmails: args.onDestroyRemoveEmails ?? false,
  });
  if (!r.ok) throw new MethodError(r.error.type, r.error.description);

  if (r.removedBlobIds.length > 0) {
    await deleteBlobs(ctx.env, accountId, r.removedBlobIds);
  }
  const created: Record<string, unknown> = {};
  for (const [key, row] of Object.entries(r.created)) {
    ctx.createdIds.set(key, row.id);
    const o = mailboxObject(row);
    created[key] = {
      id: o.id,
      sortOrder: o.sortOrder,
      totalEmails: 0,
      unreadEmails: 0,
      totalThreads: 0,
      unreadThreads: 0,
      myRights: o.myRights,
      isSubscribed: o.isSubscribed,
    };
  }
  return {
    accountId,
    oldState: r.oldState,
    newState: r.newState,
    created,
    updated: Object.fromEntries(r.updated.map((id) => [id, null])),
    destroyed: r.destroyed,
    notCreated: { ...notCreated, ...r.notCreated },
    notUpdated: { ...notUpdated, ...r.notUpdated },
    notDestroyed: r.notDestroyed,
  };
}

/** Best-effort R2 cleanup (a failure leaves an orphan blob, never a broken mailbox). */
export async function deleteBlobs(env: Env, accountId: string, blobIds: string[]): Promise<void> {
  const keys = blobIds.map((b) => `${accountId}/${b}`);
  for (let i = 0; i < keys.length; i += 500) {
    const batch = keys.slice(i, i + 500);
    try {
      await env.BLOBS.delete(batch);
    } catch (err) {
      console.error({
        msg: "r2 cleanup failed",
        accountId,
        keyCount: batch.length,
        ...errorFields(err, { stack: true }),
      });
    }
  }
}

function queryChangesUnsupported(): never {
  throw new MethodError(
    "cannotCalculateChanges",
    "queryChanges is not supported; re-run the query",
  );
}

export const mailboxMethods: Record<string, MethodDef> = {
  "Mailbox/get": { capability: CAP_MAIL, handler: mailboxGet },
  "Mailbox/changes": { capability: CAP_MAIL, handler: mailboxChanges },
  "Mailbox/query": { capability: CAP_MAIL, handler: mailboxQuery },
  "Mailbox/queryChanges": { capability: CAP_MAIL, handler: async () => queryChangesUnsupported() },
  "Mailbox/set": { capability: CAP_MAIL, handler: mailboxSet },
};
