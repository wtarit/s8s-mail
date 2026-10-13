import { z } from "zod";
import { BlobNotFoundError, MimeBuildError, buildMime } from "../../mime";
import type { EmailCreate } from "../../mime";
import { blobKey, newMessageBlobId } from "../../store/blob";
import type { EmailUpdateInput, SetOp } from "../../store/jmap-types";
import type { MethodContext } from "../context";
import { MethodError } from "../errors";
import type { MethodDef } from "../registry";
import { attachmentLimit } from "../session";
import { CAP_MAIL, LIMITS, type SetError } from "../types";
import { checkCount, ID_RE, isValidKeyword, parseDate, unescapePointerToken } from "../util";
import { parseArgs } from "./helpers";
import { deleteBlobs } from "./mailbox";

const MAX_ATTACHMENTS = 30;
const SERVER_SET = new Set([
  "id",
  "blobId",
  "threadId",
  "size",
  "receivedAt",
  "hasAttachment",
  "preview",
]);

const addressSchema = z.object({
  name: z.string().nullish(),
  email: z.string().min(1).max(998),
});
const addresses = z.array(addressSchema).nullish();
const idArray = z.array(z.string()).nullish();
const bodyRef = z.object({ partId: z.string(), type: z.string().nullish() });

const createSchema = z
  .object({
    mailboxIds: z.record(z.string(), z.boolean()),
    keywords: z.record(z.string(), z.boolean()).nullish(),
    from: addresses,
    to: addresses,
    cc: addresses,
    bcc: addresses,
    replyTo: addresses,
    sender: addresses,
    subject: z.string().nullish(),
    sentAt: z.string().nullish(),
    messageId: idArray,
    inReplyTo: idArray,
    references: idArray,
    bodyValues: z.record(z.string(), z.object({ value: z.string() })).nullish(),
    textBody: z.array(bodyRef).nullish(),
    htmlBody: z.array(bodyRef).nullish(),
    attachments: z
      .array(
        z.object({
          blobId: z.string(),
          type: z.string().min(1),
          name: z.string().nullish(),
          disposition: z.string().nullish(),
          cid: z.string().nullish(),
        }),
      )
      .nullish(),
    headers: z.array(z.object({ name: z.string(), value: z.string() })).nullish(),
  })
  .catchall(z.unknown());

class TooLargeError extends Error {}

/** Collects `header:Name[:asText|:asRaw|:asAddresses]` create properties as extra headers. */
function headerProperties(
  obj: Record<string, unknown>,
): { name: string; value: string }[] | SetError {
  const out: { name: string; value: string }[] = [];
  for (const [key, value] of Object.entries(obj)) {
    if (!key.startsWith("header:")) continue;
    const parts = key.split(":");
    const name = parts[1];
    const form = parts[2] ?? "asRaw";
    if (!name || parts.length > 3) {
      return {
        type: "invalidProperties",
        properties: [key],
        description: "Malformed header property",
      };
    }
    if (value === null || value === undefined) continue;
    if ((form === "asText" || form === "asRaw") && typeof value === "string") {
      out.push({ name, value: form === "asRaw" ? value.trim() : value });
    } else if (form === "asAddresses" && Array.isArray(value)) {
      const text = (value as { name?: string | null; email: string }[])
        .map((a) => (a.name ? `${a.name} <${a.email}>` : a.email))
        .join(", ");
      out.push({ name, value: text });
    } else {
      return {
        type: "invalidProperties",
        properties: [key],
        description: "Unsupported header form or value",
      };
    }
  }
  return out;
}

function keywordList(map: Record<string, boolean> | null | undefined): string[] | SetError {
  const out: string[] = [];
  for (const [k, v] of Object.entries(map ?? {})) {
    if (!isValidKeyword(k)) {
      return {
        type: "invalidProperties",
        properties: ["keywords"],
        description: `Invalid keyword "${k}"`,
      };
    }
    if (v) out.push(k.toLowerCase());
  }
  return out;
}

function domainOf(email: string | undefined, fallback: string): string {
  const at = email?.lastIndexOf("@") ?? -1;
  return email && at > 0
    ? email.slice(at + 1).replace(/[^A-Za-z0-9.-]/g, "") || fallback
    : fallback;
}

const strip = (l: string[] | null | undefined) => (l ?? []).map((i) => i.replace(/^<|>$/g, ""));
const norm = (l: { name?: string | null; email: string }[] | null | undefined) =>
  (l ?? []).map((a) => ({ name: a.name ?? null, email: a.email }));

/** Builds the MIME message, stores it in R2 and inserts it into the account DO. */
async function createEmail(
  ctx: MethodContext,
  accountId: string,
  rawObj: Record<string, unknown>,
): Promise<{ created: Record<string, unknown> } | { error: SetError }> {
  for (const key of Object.keys(rawObj)) {
    if (SERVER_SET.has(key)) {
      return {
        error: { type: "invalidProperties", properties: [key], description: "Server-set property" },
      };
    }
    if (key === "bodyStructure") {
      return {
        error: {
          type: "invalidProperties",
          properties: [key],
          description: "Use textBody/htmlBody/attachments instead of bodyStructure",
        },
      };
    }
  }
  const parsed = createSchema.safeParse(rawObj);
  if (!parsed.success) {
    const props = [...new Set(parsed.error.issues.map((i) => String(i.path[0] ?? "")))].filter(
      Boolean,
    );
    return {
      error: {
        type: "invalidProperties",
        properties: props,
        description: parsed.error.issues[0]?.message,
      },
    };
  }
  const o = parsed.data;
  const unknownKeys = Object.keys(rawObj).filter(
    (k) => !(k in createSchema.shape) && !k.startsWith("header:"),
  );
  if (unknownKeys.length > 0) {
    return { error: { type: "invalidProperties", properties: unknownKeys } };
  }
  const extra = headerProperties(rawObj);
  if (!Array.isArray(extra)) return { error: extra };
  const keywords = keywordList(o.keywords);
  if (!Array.isArray(keywords)) return { error: keywords };
  const mailboxIds = Object.entries(o.mailboxIds)
    .filter(([, v]) => v)
    .map(([k]) => ctx.resolveId(k));
  if (mailboxIds.length === 0) {
    return {
      error: {
        type: "invalidProperties",
        properties: ["mailboxIds"],
        description: "At least one mailbox is required",
      },
    };
  }
  if (!o.from || o.from.length === 0) {
    return {
      error: { type: "invalidProperties", properties: ["from"], description: "From is required" },
    };
  }
  if ((o.attachments?.length ?? 0) > MAX_ATTACHMENTS) {
    return {
      error: {
        type: "invalidProperties",
        properties: ["attachments"],
        description: `At most ${MAX_ATTACHMENTS} attachments`,
      },
    };
  }

  const limit = attachmentLimit(ctx.env);
  let attachmentBytes = 0;
  const fetchBlob = async (blobId: string): Promise<Uint8Array | null> => {
    if (!ID_RE.test(blobId)) return null;
    const obj = await ctx.env.BLOBS.get(blobKey(accountId, blobId));
    if (!obj) return null;
    attachmentBytes += obj.size;
    if (attachmentBytes > limit) {
      await obj.body.cancel();
      throw new TooLargeError();
    }
    return new Uint8Array(await obj.arrayBuffer());
  };

  const create: EmailCreate = {
    from: o.from,
    to: o.to,
    cc: o.cc,
    bcc: o.bcc,
    replyTo: o.replyTo,
    sender: o.sender,
    subject: o.subject,
    sentAt: o.sentAt,
    messageId: o.messageId,
    inReplyTo: o.inReplyTo,
    references: o.references,
    bodyValues: o.bodyValues,
    textBody: o.textBody,
    htmlBody: o.htmlBody,
    attachments: o.attachments,
    headers: [...(o.headers ?? []), ...extra],
  };
  const now = Date.now();
  let built;
  try {
    built = await buildMime(create, {
      fetchBlob,
      messageIdDomain: domainOf(o.from[0]?.email, new URL(ctx.env.PUBLIC_URL).hostname),
      includeBcc: true,
      now: new Date(now),
    });
  } catch (err) {
    if (err instanceof BlobNotFoundError) {
      return {
        error: {
          type: "blobNotFound",
          description: `Blob ${err.blobId} not found`,
          notFound: [err.blobId],
        },
      };
    }
    if (err instanceof TooLargeError) {
      return {
        error: {
          type: "tooLarge",
          description: `Attachments exceed ${limit} bytes (maxSizeAttachmentsPerEmail)`,
          maxSize: limit,
        },
      };
    }
    if (err instanceof MimeBuildError) {
      return {
        error: {
          type: "invalidProperties",
          properties: err.property ? [err.property] : [],
          description: err.message,
        },
      };
    }
    throw err;
  }

  const blobId = newMessageBlobId();
  const key = blobKey(accountId, blobId);
  await ctx.env.BLOBS.put(key, built.raw, { httpMetadata: { contentType: "message/rfc822" } });
  const r = await ctx.stub(accountId).emailCreate({
    accountId,
    blobId,
    size: built.size,
    receivedAt: now,
    headers: {
      messageId: built.messageId,
      inReplyTo: strip(o.inReplyTo),
      references: strip(o.references),
      subject: o.subject ?? null,
      sentAt: (o.sentAt ? parseDate(o.sentAt) : null) ?? now,
      from: norm(o.from),
      sender: norm(o.sender),
      to: norm(o.to),
      cc: norm(o.cc),
      bcc: norm(o.bcc),
      replyTo: norm(o.replyTo),
    },
    mailboxIds,
    keywords,
  });
  if (!r.ok) {
    await ctx.env.BLOBS.delete(key).catch(() => {});
    return { error: r.error };
  }
  return { created: { id: r.emailId, blobId, threadId: r.threadId, size: built.size } };
}

const invalid = (key: string, description: string): SetError => ({
  type: "invalidProperties",
  properties: [key],
  description,
});

/** Turns a PatchObject (or full-value update) into store operations. */
function parseUpdate(
  ctx: MethodContext,
  id: string,
  patch: Record<string, unknown>,
): EmailUpdateInput | SetError {
  const op: EmailUpdateInput = { id };
  const kw: SetOp = {};
  const mb: SetOp = {};
  let kwWhole = false;
  let kwPatch = false;
  let mbWhole = false;
  let mbPatch = false;
  for (const [key, value] of Object.entries(patch)) {
    if (key === "keywords") {
      const list = keywordList(value as Record<string, boolean>);
      if (!Array.isArray(list) || value === null || typeof value !== "object") {
        return Array.isArray(list) ? invalid(key, "keywords must be an object") : list;
      }
      kw.set = list;
      kwWhole = true;
    } else if (key.startsWith("keywords/")) {
      const k = unescapePointerToken(key.slice("keywords/".length));
      if (!isValidKeyword(k)) return invalid("keywords", `Invalid keyword "${k}"`);
      if (value === true) (kw.add ??= []).push(k.toLowerCase());
      else if (value === null || value === false) (kw.remove ??= []).push(k.toLowerCase());
      else return invalid(key, "Keyword patch values must be true or null");
      kwPatch = true;
    } else if (key === "mailboxIds") {
      const m = value as Record<string, boolean> | null;
      if (m === null || typeof m !== "object" || Array.isArray(m)) {
        return invalid(key, "mailboxIds must be an object");
      }
      mb.set = Object.entries(m)
        .filter(([, v]) => v)
        .map(([k]) => ctx.resolveId(k));
      mbWhole = true;
    } else if (key.startsWith("mailboxIds/")) {
      const k = ctx.resolveId(unescapePointerToken(key.slice("mailboxIds/".length)));
      if (value === true) (mb.add ??= []).push(k);
      else if (value === null || value === false) (mb.remove ??= []).push(k);
      else return invalid(key, "Mailbox patch values must be true or null");
      mbPatch = true;
    } else {
      return invalid(key, "This property is immutable");
    }
  }
  if ((kwWhole && kwPatch) || (mbWhole && mbPatch)) {
    return { type: "invalidPatch", description: "Cannot combine a whole value and patches" };
  }
  if (kwWhole || kwPatch) op.keywords = kw;
  if (mbWhole || mbPatch) op.mailboxIds = mb;
  return op;
}

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
