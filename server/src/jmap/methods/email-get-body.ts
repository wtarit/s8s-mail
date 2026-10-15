import { blobKey } from "../../store/blob";
import type { BodyPart } from "../../store/types";
import type { MethodContext } from "../context";
import { HEADER_READ_BYTES, parseHeaderBlock } from "../rawheaders";

export const DEFAULT_BODY_PROPERTIES = [
  "partId",
  "blobId",
  "size",
  "name",
  "type",
  "charset",
  "disposition",
  "cid",
  "language",
  "location",
];

export function formatPart(
  part: BodyPart,
  bodyProps: Set<string>,
  tree: boolean,
): Record<string, unknown> {
  const full: Record<string, unknown> = {
    partId: part.partId,
    blobId: part.blobId,
    size: part.size,
    name: part.name,
    type: part.type,
    charset: part.charset,
    disposition: part.disposition,
    cid: part.cid,
    language: null,
    location: null,
    headers: [],
  };
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(full)) if (bodyProps.has(key)) out[key] = full[key];
  if (tree && part.subParts)
    out.subParts = part.subParts.map((p) => formatPart(p, bodyProps, true));
  return out;
}

export function leaves(part: BodyPart | null | undefined): BodyPart[] {
  if (!part) return [];
  return part.subParts ? part.subParts.flatMap(leaves) : [part];
}

export type BodyTree = {
  bodyStructure: BodyPart;
  textBody: BodyPart[];
  htmlBody: BodyPart[];
  attachments: BodyPart[];
};

/** Placeholder body for a message the DO has not parsed (and we did not parse on demand). */
export function placeholderBody(): BodyTree {
  const part: BodyPart = {
    partId: "1",
    blobId: null,
    size: 0,
    type: "text/plain",
    charset: "utf-8",
    name: null,
    disposition: null,
    cid: null,
    subParts: null,
  };
  return { bodyStructure: part, textBody: [part], htmlBody: [part], attachments: [] };
}

export async function readHead(ctx: MethodContext, accountId: string, blobId: string) {
  if (ctx.r2Budget <= 0) return null;
  ctx.r2Budget--;
  const obj = await ctx.env.BLOBS.get(blobKey(accountId, blobId), {
    range: { offset: 0, length: HEADER_READ_BYTES },
  });
  return obj ? parseHeaderBlock(new Uint8Array(await obj.arrayBuffer())) : null;
}

export type PartValue = { value: string; isEncodingProblem: boolean; isTruncated: boolean };

export function truncateUtf8(bytes: Uint8Array, max: number): { text: string; truncated: boolean } {
  if (max > 0 && bytes.byteLength > max) {
    return {
      text: new TextDecoder("utf-8").decode(bytes.subarray(0, max), { stream: true }),
      truncated: true,
    };
  }
  return { text: new TextDecoder("utf-8").decode(bytes), truncated: false };
}

export async function readPartValue(
  ctx: MethodContext,
  accountId: string,
  part: BodyPart,
  max: number,
): Promise<PartValue> {
  if (!part.blobId || ctx.r2Budget <= 0) {
    // Out of subrequest budget: report truncated so the client refetches in a new request.
    return { value: "", isEncodingProblem: false, isTruncated: true };
  }
  ctx.r2Budget--;
  const obj = await ctx.env.BLOBS.get(
    blobKey(accountId, part.blobId),
    max > 0 ? { range: { offset: 0, length: max + 4 } } : undefined,
  );
  if (!obj) return { value: "", isEncodingProblem: false, isTruncated: true };
  const bytes = new Uint8Array(await obj.arrayBuffer());
  const { text, truncated } = truncateUtf8(bytes, max);
  return {
    value: text,
    isEncodingProblem: false,
    isTruncated: truncated || (max > 0 && part.size > max),
  };
}
