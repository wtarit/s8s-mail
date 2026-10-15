import { z } from "zod";
import { MethodError } from "../errors";
import { parseMessage, type ParsedBody } from "../../store/parse";
import { blobKey } from "../../store/blob";
import type { BodyPart, EmailAddress } from "../../store/types";
import type { MethodContext } from "../context";
import { headerPropertyValue, parseHeaderProperty, type RawHeader } from "../rawheaders";
import type { MethodDef } from "../registry";
import { CAP_MAIL, LIMITS } from "../types";
import { errorFields } from "../../log";
import { checkCount, utcDate } from "../util";
import {
  DEFAULT_BODY_PROPERTIES,
  formatPart,
  leaves,
  placeholderBody,
  readHead,
  readPartValue,
  truncateUtf8,
  type BodyTree,
  type PartValue,
} from "./email-get-body";
import { changesArgs, getArgs, parseArgs } from "./helpers";
import { changesResponse } from "./mailbox";

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
  // On-demand parsing (CPU) only when the response actually needs decoded body content.
  const needsParsedBody =
    props.has("textBody") ||
    props.has("htmlBody") ||
    props.has("attachments") ||
    props.has("bodyStructure") ||
    (props.has("bodyValues") &&
      (args.fetchTextBodyValues || args.fetchHTMLBodyValues || args.fetchAllBodyValues));
  const needsHeaders = props.has("headers") || headerProps.size > 0;
  const bodyProps = new Set(args.bodyProperties ?? DEFAULT_BODY_PROPERTIES);
  const maxBytes = args.maxBodyValueBytes ?? 0;

  const ids = args.ids.map((i) => ctx.resolveId(i));
  const result = await ctx.stub(accountId).emailGet(ids, needsBody);
  const byId = new Map(result.rows.map((r) => [r.id, r]));

  // Rows the DO has not parsed yet: parse a few small ones now (not persisted).
  const onDemand = new Map<string, ParsedBody>();
  if (needsParsedBody) {
    for (const row of result.rows) {
      if (row.parseState === "parsed" || onDemand.size >= ON_DEMAND_MAX_PER_REQUEST) continue;
      if (row.size > ON_DEMAND_MAX_RAW_BYTES || ctx.r2Budget <= 0) continue;
      ctx.r2Budget--;
      const obj = await ctx.env.BLOBS.get(blobKey(accountId, row.blobId));
      if (!obj) continue;
      try {
        onDemand.set(row.id, await parseMessage(obj.body, row.blobId));
      } catch (err) {
        console.error({
          msg: "on-demand parse failed",
          accountId,
          emailId: row.id,
          blobId: row.blobId,
          ...errorFields(err, { stack: true }),
        });
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
