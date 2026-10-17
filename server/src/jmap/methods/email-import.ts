import { z } from "zod";
import { extractIngestHeaders, parseAddressList } from "../../mail/headers";
import { blobKey, newMessageBlobId } from "../../store/blob";
import type { MethodContext } from "../context";
import { HEADER_READ_BYTES, parseHeaderBlock, toHeaders } from "../rawheaders";
import type { MethodDef } from "../registry";
import { CAP_MAIL, LIMITS, type SetError } from "../types";
import { checkCount, ID_RE, isValidKeyword, parseDate } from "../util";
import { parseArgs } from "./helpers";

const importArgs = z.object({
  accountId: z.string(),
  ifInState: z.string().nullish(),
  emails: z.record(
    z.string(),
    z.object({
      blobId: z.string(),
      mailboxIds: z.record(z.string(), z.boolean()),
      keywords: z.record(z.string(), z.boolean()).nullish(),
      receivedAt: z.string().nullish(),
    }),
  ),
});

/**
 * Email/import (RFC 8621 §4.8): copies an uploaded RFC 5322 blob to a new message blob (so the
 * same upload can be imported twice) and inserts it with the given mailboxes/keywords.
 * Costs 3 R2 operations per message (head read, copy get, copy put).
 */
async function emailImport(ctx: MethodContext, raw: Record<string, unknown>) {
  const args = parseArgs(importArgs, raw);
  const accountId = ctx.account(raw);
  const entries = Object.entries(args.emails);
  checkCount(entries.length, LIMITS.maxObjectsInSet, "emails");
  const stub = ctx.stub(accountId);
  const before = await stub.getAllStates();
  const created: Record<string, unknown> = {};
  const notCreated: Record<string, SetError> = {};

  for (const [cid, item] of entries) {
    if (!ID_RE.test(item.blobId)) {
      notCreated[cid] = { type: "blobNotFound", notFound: [item.blobId] };
      continue;
    }
    const keywords = Object.entries(item.keywords ?? {}).filter(([, v]) => v);
    if (keywords.some(([k]) => !isValidKeyword(k))) {
      notCreated[cid] = { type: "invalidProperties", properties: ["keywords"] };
      continue;
    }
    const head = await ctx.env.BLOBS.get(blobKey(accountId, item.blobId), {
      range: { offset: 0, length: HEADER_READ_BYTES },
    });
    if (!head) {
      notCreated[cid] = { type: "blobNotFound", notFound: [item.blobId] };
      continue;
    }
    const headerList = parseHeaderBlock(new Uint8Array(await head.arrayBuffer()));
    if (headerList.length === 0) {
      notCreated[cid] = {
        type: "invalidEmail",
        description: "The blob is not an RFC 5322 message",
      };
      continue;
    }
    const src = await ctx.env.BLOBS.get(blobKey(accountId, item.blobId));
    if (!src) {
      notCreated[cid] = { type: "blobNotFound", notFound: [item.blobId] };
      continue;
    }
    const newBlob = newMessageBlobId();
    const key = blobKey(accountId, newBlob);
    const { readable, writable } = new FixedLengthStream(src.size);
    await Promise.all([
      ctx.env.BLOBS.put(key, readable, { httpMetadata: { contentType: "message/rfc822" } }),
      src.body.pipeTo(writable),
    ]);
    const headers = toHeaders(headerList);
    const h = extractIngestHeaders(headers);
    const r = await stub.emailCreate({
      accountId,
      blobId: newBlob,
      size: src.size,
      receivedAt: (item.receivedAt ? parseDate(item.receivedAt) : null) ?? Date.now(),
      headers: { ...h, bcc: parseAddressList(headers.get("bcc")) },
      mailboxIds: Object.entries(item.mailboxIds)
        .filter(([, v]) => v)
        .map(([k]) => ctx.resolveId(k)),
      keywords: keywords.map(([k]) => k.toLowerCase()),
    });
    if (!r.ok) {
      await ctx.env.BLOBS.delete(key).catch(() => {});
      notCreated[cid] = r.error;
    } else {
      created[cid] = { id: r.emailId, blobId: newBlob, threadId: r.threadId, size: src.size };
      ctx.createdIds.set(cid, r.emailId);
    }
  }
  const after = await stub.getAllStates();
  return {
    accountId,
    oldState: before.Email,
    newState: after.Email,
    created: Object.keys(created).length > 0 ? created : null,
    notCreated: Object.keys(notCreated).length > 0 ? notCreated : null,
  };
}

export const emailImportMethods: Record<string, MethodDef> = {
  "Email/import": { capability: CAP_MAIL, handler: emailImport },
};
