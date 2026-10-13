import { z } from "zod";
import { MethodError } from "../errors";
import { parseMessage, type ParsedBody } from "../../store/parse";
import { blobKey } from "../../store/blob";
import type { EmailRow } from "../../store/jmap-types";
import type { BodyPart, EmailAddress } from "../../store/types";
import type { MethodContext } from "../context";
import {
  HEADER_READ_BYTES,
  headerPropertyValue,
  parseHeaderBlock,
  parseHeaderProperty,
  type RawHeader,
} from "../rawheaders";
import type { MethodDef } from "../registry";
import { CAP_MAIL, LIMITS } from "../types";
import { checkCount, utcDate } from "../util";
import { getArgs, parseArgs } from "./helpers";
import { changesResponse } from "./mailbox";
import { changesArgs } from "./helpers";

const SCALAR_PROPERTIES = [
  "id",
  "blobId",
  "threadId",
  "mailboxIds",
  "keywords",
  "size",
  "receivedAt",
  "headers",
  "messageId",
  "inReplyTo",
  "references",
  "sender",
  "from",
  "to",
  "cc",
  "bcc",
  "replyTo",
  "subject",
  "sentAt",
  "bodyStructure",
  "bodyValues",
  "textBody",
  "htmlBody",
  "attachments",
  "hasAttachment",
  "preview",
] as const;
const KNOWN = new Set<string>(SCALAR_PROPERTIES);
const DEFAULT_PROPERTIES = SCALAR_PROPERTIES.filter(
  (p) => p !== "headers" && p !== "bodyStructure",
);
const BODY_PROPS = new Set(["bodyStructure", "bodyValues", "textBody", "htmlBody", "attachments"]);
const DEFAULT_BODY_PROPERTIES = [
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

/** Raw messages up to this size are parsed on demand when the DO has not parsed them yet. */
export const ON_DEMAND_MAX_RAW_BYTES = 128 * 1024;
/** At most this many on-demand parses per HTTP request (CPU: 10 ms on Workers Free). */
export const ON_DEMAND_MAX_PER_REQUEST = 3;

const emailGetArgs = getArgs.extend({
  bodyProperties: z.array(z.string()).nullable().optional(),
  fetchTextBodyValues: z.boolean().optional(),
  fetchHTMLBodyValues: z.boolean().optional(),
  fetchAllBodyValues: z.boolean().optional(),
  maxBodyValueBytes: z.number().int().min(0).nullable().optional(),
});

const list = (a: EmailAddress[] | null) => (a && a.length > 0 ? a : null);
const addr = (a: EmailAddress[] | null) =>
  list(a)?.map((x) => ({ name: x.name ?? null, email: x.email })) ?? null;
const flag = (names: string[]) => Object.fromEntries(names.map((n) => [n, true]));

function formatPart(
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

function leaves(part: BodyPart | null | undefined): BodyPart[] {
  if (!part) return [];
  return part.subParts ? part.subParts.flatMap(leaves) : [part];
}

type BodyTree = {
  bodyStructure: BodyPart;
  textBody: BodyPart[];
  htmlBody: BodyPart[];
  attachments: BodyPart[];
};

/** Placeholder body for a message the DO has not parsed (and we did not parse on demand). */
function placeholderBody(): BodyTree {
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

async function readHead(ctx: MethodContext, accountId: string, blobId: string) {
  if (ctx.r2Budget <= 0) return null;
  ctx.r2Budget--;
  const obj = await ctx.env.BLOBS.get(blobKey(accountId, blobId), {
    range: { offset: 0, length: HEADER_READ_BYTES },
  });
  return obj ? parseHeaderBlock(new Uint8Array(await obj.arrayBuffer())) : null;
}

type PartValue = { value: string; isEncodingProblem: boolean; isTruncated: boolean };

function truncateUtf8(bytes: Uint8Array, max: number): { text: string; truncated: boolean } {
  if (max > 0 && bytes.byteLength > max) {
    return {
      text: new TextDecoder("utf-8").decode(bytes.subarray(0, max), { stream: true }),
      truncated: true,
    };
  }
  return { text: new TextDecoder("utf-8").decode(bytes), truncated: false };
}

async function readPartValue(
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

async function emailGet(ctx: MethodContext, raw: Record<string, unknown>) {
  const args = parseArgs(emailGetArgs, raw);
  const accountId = ctx.account(raw);
  if (!args.ids) throw new MethodError("requestTooLarge", "ids must be given for Email/get");
  checkCount(args.ids.length, LIMITS.maxObjectsInGet, "ids");

  const wanted = args.properties ?? [...DEFAULT_PROPERTIES];
  const headerProps = new Map<string, NonNullable<ReturnType<typeof parseHeaderProperty>>>();
  for (const p of wanted) {
    if (KNOWN.has(p)) continue;
    const hp = parseHeaderProperty(p);
    if (!hp) throw new MethodError("invalidArguments", `Unknown property "${p}"`);
    headerProps.set(p, hp);
  }
  const props = new Set(wanted);
  const needsBody = [...BODY_PROPS].some((p) => props.has(p));
  const needsHeaders = props.has("headers") || headerProps.size > 0;
  const bodyProps = new Set(args.bodyProperties ?? DEFAULT_BODY_PROPERTIES);
  const maxBytes = args.maxBodyValueBytes ?? 0;

  const ids = args.ids.map((i) => ctx.resolveId(i));
  const result = await ctx.stub(accountId).emailGet(ids, needsBody);
  const byId = new Map(result.rows.map((r) => [r.id, r]));

  // Rows the DO has not parsed yet: parse a few small ones now (not persisted).
  const onDemand = new Map<string, ParsedBody>();
  if (needsBody) {
    for (const row of result.rows) {
      if (row.parseState === "parsed" || onDemand.size >= ON_DEMAND_MAX_PER_REQUEST) continue;
      if (row.size > ON_DEMAND_MAX_RAW_BYTES || ctx.r2Budget <= 0) continue;
      ctx.r2Budget--;
      const obj = await ctx.env.BLOBS.get(blobKey(accountId, row.blobId));
      if (!obj) continue;
      try {
        onDemand.set(row.id, await parseMessage(obj.body, row.blobId));
      } catch (err) {
        console.error("on-demand parse failed", err);
      }
    }
  }

  const out: Record<string, unknown>[] = [];
  for (const id of ids) {
    const row = byId.get(id);
    if (!row) continue;
    const parsed = onDemand.get(id);
    const body: BodyTree | null = !needsBody
      ? null
      : parsed
        ? {
            bodyStructure: parsed.bodyStructure,
            textBody: parsed.textBody,
            htmlBody: parsed.htmlBody,
            attachments: parsed.attachments,
          }
        : row.parseState === "parsed" && row.bodyStructure
          ? {
              bodyStructure: row.bodyStructure,
              textBody: row.textBody ?? [],
              htmlBody: row.htmlBody ?? [],
              attachments: row.attachments ?? [],
            }
          : placeholderBody();

    const o: Record<string, unknown> = { id: row.id };
    const full: Record<string, () => unknown> = {
      id: () => row.id,
      blobId: () => row.blobId,
      threadId: () => row.threadId,
      mailboxIds: () => flag(row.mailboxIds),
      keywords: () => flag(row.keywords),
      size: () => row.size,
      receivedAt: () => utcDate(row.receivedAt),
      messageId: () => (row.messageId ? [row.messageId] : null),
      inReplyTo: () => (row.inReplyTo && row.inReplyTo.length > 0 ? row.inReplyTo : null),
      references: () => (row.references && row.references.length > 0 ? row.references : null),
      sender: () => addr(row.sender),
      from: () => addr(row.from),
      to: () => addr(row.to),
      cc: () => addr(row.cc),
      bcc: () => addr(row.bcc),
      replyTo: () => addr(row.replyTo),
      subject: () => row.subject,
      sentAt: () => (row.sentAt === null ? null : utcDate(row.sentAt)),
      hasAttachment: () => (parsed ? parsed.hasAttachment : row.hasAttachment),
      preview: () => (parsed ? parsed.preview : row.preview),
      bodyStructure: () => formatPart(body!.bodyStructure, bodyProps, true),
      textBody: () => body!.textBody.map((p) => formatPart(p, bodyProps, false)),
      htmlBody: () => body!.htmlBody.map((p) => formatPart(p, bodyProps, false)),
      attachments: () => body!.attachments.map((p) => formatPart(p, bodyProps, false)),
    };
    for (const p of wanted) {
      if (p === "bodyValues" || p === "headers" || headerProps.has(p)) continue;
      const fn = full[p];
      if (fn) o[p] = fn();
    }

    if (props.has("bodyValues") && body) {
      const parts = new Map<string, BodyPart>();
      const add = (p: BodyPart) => {
        if (p.partId && p.type.startsWith("text/")) parts.set(p.partId, p);
      };
      if (args.fetchTextBodyValues) body.textBody.forEach(add);
      if (args.fetchHTMLBodyValues) body.htmlBody.forEach(add);
      if (args.fetchAllBodyValues) leaves(body.bodyStructure).forEach(add);
      const values: Record<string, PartValue> = {};
      for (const [partId, part] of parts) {
        const pd = parsed?.parts.find((x) => x.partId === partId);
        if (pd && typeof pd.content === "string") {
          const bytes = new TextEncoder().encode(pd.content);
          const t = truncateUtf8(bytes, maxBytes);
          values[partId] = { value: t.text, isEncodingProblem: false, isTruncated: t.truncated };
        } else if (!parsed && row.parseState !== "parsed") {
          values[partId] = { value: "", isEncodingProblem: false, isTruncated: true };
        } else {
          values[partId] = await readPartValue(ctx, accountId, part, maxBytes);
        }
      }
      o.bodyValues = values;
    }

    if (needsHeaders) {
      const headers: RawHeader[] = (await readHead(ctx, accountId, row.blobId)) ?? [];
      if (props.has("headers")) o.headers = headers;
      for (const [p, hp] of headerProps) o[p] = headerPropertyValue(headers, hp);
    }
    out.push(o);
  }
  return { accountId, state: result.state, list: out, notFound: result.notFound };
}

async function emailChanges(ctx: MethodContext, raw: Record<string, unknown>) {
  const args = parseArgs(changesArgs, raw);
  const accountId = ctx.account(raw);
  return changesResponse(ctx, accountId, "Email", args.sinceState, args.maxChanges);
}

export const emailGetMethods: Record<string, MethodDef> = {
  "Email/get": { capability: CAP_MAIL, handler: emailGet },
  "Email/changes": { capability: CAP_MAIL, handler: emailChanges },
};
