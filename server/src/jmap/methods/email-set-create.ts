import { z } from "zod";
import { BlobNotFoundError, MimeBuildError, buildMime } from "../../mime";
import type { EmailCreate } from "../../mime";
import { blobKey, newMessageBlobId } from "../../store/blob";
import type { MethodContext } from "../context";
import { attachmentLimit } from "../session";
import type { SetError } from "../types";
import { ID_RE, parseDate } from "../util";
import { keywordList } from "./email-set-patch";

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
export async function createEmail(
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
