import { z } from "zod";
import type { IdentitySettingRow } from "../../store/jmap-types";
import type { MethodContext } from "../context";
import { MethodError } from "../errors";
import type { MethodDef } from "../registry";
import { CAP_SUBMISSION, LIMITS, type SetError } from "../types";
import { checkCount, identityIdFor, shortHash } from "../util";
import { getArgs, parseArgs, pick, propertySet } from "./helpers";

const IDENTITY_PROPERTIES = new Set([
  "id",
  "name",
  "email",
  "replyTo",
  "bcc",
  "textSignature",
  "htmlSignature",
  "mayDelete",
]);

export type IdentityObject = ReturnType<typeof identityObject>;

function identityObject(
  id: string,
  email: string,
  accountName: string,
  s: IdentitySettingRow | undefined,
) {
  return {
    id,
    name: s?.name ?? accountName,
    email,
    replyTo: s?.replyTo ?? null,
    bcc: s?.bcc ?? null,
    textSignature: s?.textSignature ?? "",
    htmlSignature: s?.htmlSignature ?? "",
    mayDelete: false,
  };
}

/** All identities of the account (one per address, primary first) with the stored settings. */
export async function loadIdentities(ctx: MethodContext, accountId: string) {
  const [addrs, info, settings, states] = await Promise.all([
    ctx.accountAddresses(accountId),
    ctx.accountInfo(accountId),
    ctx.stub(accountId).identitySettings(),
    ctx.stub(accountId).getAllStates(),
  ]);
  const byAddress = new Map(settings.map((s) => [s.address, s]));
  const list = await Promise.all(
    addrs.map(async (a) =>
      identityObject(
        await identityIdFor(a.address),
        a.address,
        info?.name ?? a.address,
        byAddress.get(a.address),
      ),
    ),
  );
  // State covers both the stored settings and the address list (aliases managed in D1).
  const state = `${states.Identity}.${await shortHash(addrs.map((a) => a.address).join(","), 3)}`;
  return { list, state };
}

async function identityGet(ctx: MethodContext, raw: Record<string, unknown>) {
  const args = parseArgs(getArgs, raw);
  const accountId = ctx.account(raw);
  const props = propertySet(args.properties, IDENTITY_PROPERTIES);
  if (args.ids) checkCount(args.ids.length, LIMITS.maxObjectsInGet, "ids");
  const { list, state } = await loadIdentities(ctx, accountId);
  const wanted = args.ids ? args.ids.map((i) => ctx.resolveId(i)) : null;
  const out = wanted ? list.filter((i) => wanted.includes(i.id)) : list;
  const found = new Set(out.map((i) => i.id));
  return {
    accountId,
    state,
    list: out.map((i) => pick(i, props)),
    notFound: wanted ? wanted.filter((i) => !found.has(i)) : [],
  };
}

const addressList = z
  .array(z.object({ name: z.string().nullish(), email: z.string().min(3) }))
  .nullable();
const updateSchema = z.object({
  name: z.string().max(255).optional(),
  replyTo: addressList.optional(),
  bcc: addressList.optional(),
  textSignature: z.string().max(65536).optional(),
  htmlSignature: z.string().max(262144).optional(),
});

const setArgs = z.object({
  accountId: z.string(),
  ifInState: z.string().nullish(),
  create: z.record(z.string(), z.record(z.string(), z.unknown())).nullish(),
  update: z.record(z.string(), z.record(z.string(), z.unknown())).nullish(),
  destroy: z.array(z.string()).nullish(),
});

async function identitySet(ctx: MethodContext, raw: Record<string, unknown>) {
  const args = parseArgs(setArgs, raw);
  const accountId = ctx.account(raw);
  checkCount(
    Object.keys(args.create ?? {}).length +
      Object.keys(args.update ?? {}).length +
      (args.destroy?.length ?? 0),
    LIMITS.maxObjectsInSet,
    "objects",
  );
  const { list, state } = await loadIdentities(ctx, accountId);
  if (args.ifInState != null && args.ifInState !== state) throw new MethodError("stateMismatch");

  const notCreated: Record<string, SetError> = {};
  for (const key of Object.keys(args.create ?? {})) {
    notCreated[key] = {
      type: "forbidden",
      description: "Identities are managed by the administrator (addresses and aliases)",
    };
  }
  const notDestroyed: Record<string, SetError> = {};
  for (const id of args.destroy ?? []) {
    notDestroyed[id] = { type: "forbidden", description: "Identities cannot be deleted" };
  }

  const updated: Record<string, null> = {};
  const notUpdated: Record<string, SetError> = {};
  const writes: Record<string, z.infer<typeof updateSchema>> = {};
  const byId = new Map(list.map((i) => [i.id, i]));
  for (const [rawId, patch] of Object.entries(args.update ?? {})) {
    const identity = byId.get(ctx.resolveId(rawId));
    if (!identity) {
      notUpdated[rawId] = { type: "notFound" };
      continue;
    }
    const parsed = updateSchema.strict().safeParse(patch);
    if (!parsed.success) {
      const props = parsed.error.issues.flatMap((i) =>
        i.code === "unrecognized_keys" ? i.keys : [String(i.path[0])],
      );
      notUpdated[rawId] = { type: "invalidProperties", properties: props };
      continue;
    }
    writes[identity.email] = parsed.data;
    updated[rawId] = null;
  }
  let newState = state;
  if (Object.keys(writes).length > 0) {
    await ctx.stub(accountId).identitySettingsSet(
      accountId,
      Object.fromEntries(
        Object.entries(writes).map(([addr, w]) => [
          addr,
          {
            ...w,
            replyTo: w.replyTo?.map((a) => ({ name: a.name ?? null, email: a.email })),
            bcc: w.bcc?.map((a) => ({ name: a.name ?? null, email: a.email })),
          },
        ]),
      ),
    );
    newState = (await loadIdentities(ctx, accountId)).state;
  }
  return {
    accountId,
    oldState: state,
    newState,
    created: null,
    updated,
    destroyed: null,
    notCreated: Object.keys(notCreated).length > 0 ? notCreated : null,
    notUpdated: Object.keys(notUpdated).length > 0 ? notUpdated : null,
    notDestroyed: Object.keys(notDestroyed).length > 0 ? notDestroyed : null,
  };
}

export const identityMethods: Record<string, MethodDef> = {
  "Identity/get": { capability: CAP_SUBMISSION, handler: identityGet },
  "Identity/changes": {
    capability: CAP_SUBMISSION,
    handler: async () => {
      throw new MethodError(
        "cannotCalculateChanges",
        "Identity changes are not tracked; call Identity/get",
      );
    },
  },
  "Identity/set": { capability: CAP_SUBMISSION, handler: identitySet },
};
