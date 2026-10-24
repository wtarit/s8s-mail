import { z } from "zod";
import { buildFtsQuery } from "../../store/jmap-filter";
import type { EmailCondition, EmailFilter, EmailSort } from "../../store/jmap-types";
import type { MethodContext } from "../context";
import { MethodError } from "../errors";
import type { MethodDef } from "../registry";
import { CAP_MAIL, LIMITS } from "../types";
import { asRecord, checkCount, escapeHtml, parseDate } from "../util";
import { idList, parseArgs } from "./helpers";

const SORT_PROPERTIES = new Set([
  "receivedAt",
  "sentAt",
  "size",
  "from",
  "to",
  "subject",
  "hasKeyword",
  "allInThreadHaveKeyword",
  "someInThreadHaveKeyword",
]);
export const MAX_QUERY_LIMIT = 500;
const MAX_FILTER_DEPTH = 16;

function bad(msg: string): never {
  throw new MethodError("invalidArguments", msg);
}

/** Validates a JMAP Email filter and converts it to the store's shape (dates -> ms). */
export function normalizeFilter(ctx: MethodContext, f: unknown, depth = 0): EmailFilter {
  const obj = asRecord(f);
  if (!obj) bad("filter must be an object");
  if (depth > MAX_FILTER_DEPTH)
    throw new MethodError("unsupportedFilter", "Filter is nested too deeply");
  if ("operator" in obj) {
    const { operator, conditions } = obj;
    if (operator !== "AND" && operator !== "OR" && operator !== "NOT") {
      bad("filter operator must be AND, OR or NOT");
    }
    if (!Array.isArray(conditions)) bad("filter conditions must be an array");
    return {
      operator,
      conditions: conditions.map((c) => normalizeFilter(ctx, c, depth + 1)),
    };
  }
  const out: EmailCondition = {};
  const str = (k: string): string => {
    const v = obj[k];
    if (typeof v !== "string") bad(`filter ${k} must be a string`);
    return v;
  };
  const num = (k: string): number => {
    const v = obj[k];
    if (typeof v !== "number" || !Number.isFinite(v)) bad(`filter ${k} must be a number`);
    return v;
  };
  const date = (k: string): number => {
    const ms = parseDate(str(k));
    if (ms === null) bad(`filter ${k} must be a date-time`);
    return ms;
  };
  for (const key of Object.keys(obj)) {
    switch (key) {
      case "inMailbox":
        out.inMailbox = ctx.resolveId(str(key));
        break;
      case "inMailboxOtherThan": {
        const v = obj[key];
        if (!Array.isArray(v) || v.some((x) => typeof x !== "string")) {
          bad("filter inMailboxOtherThan must be a string array");
        }
        out.inMailboxOtherThan = (v as string[]).map((x) => ctx.resolveId(x));
        break;
      }
      case "before":
        out.before = date(key);
        break;
      case "after":
        out.after = date(key);
        break;
      case "minSize":
      case "maxSize":
        out[key] = num(key);
        break;
      case "allInThreadHaveKeyword":
      case "someInThreadHaveKeyword":
      case "noneInThreadHaveKeyword":
      case "hasKeyword":
      case "notKeyword":
      case "text":
      case "from":
      case "to":
      case "cc":
      case "bcc":
      case "subject":
      case "body":
        out[key] = str(key);
        break;
      case "hasAttachment":
        if (typeof obj[key] !== "boolean") bad("filter hasAttachment must be a boolean");
        out.hasAttachment = obj[key] as boolean;
        break;
      case "header": {
        const v = obj[key];
        if (
          !Array.isArray(v) ||
          v.length < 1 ||
          v.length > 2 ||
          v.some((x) => typeof x !== "string")
        ) {
          bad("filter header must be [name] or [name, value]");
        }
        out.header = v as string[];
        break;
      }
      default:
        throw new MethodError("unsupportedFilter", `Unsupported filter property "${key}"`);
    }
  }
  return out;
}

const queryArgs = z.object({
  accountId: z.string(),
  filter: z.record(z.string(), z.unknown()).nullable().optional(),
  sort: z
    .array(
      z.object({
        property: z.string(),
        isAscending: z.boolean().optional(),
        keyword: z.string().optional(),
        collation: z.string().optional(),
      }),
    )
    .nullable()
    .optional(),
  position: z.number().int().optional(),
  anchor: z.string().nullable().optional(),
  anchorOffset: z.number().int().optional(),
  limit: z.number().int().min(0).nullable().optional(),
  calculateTotal: z.boolean().optional(),
  collapseThreads: z.boolean().optional(),
});

async function emailQuery(ctx: MethodContext, raw: Record<string, unknown>) {
  const args = parseArgs(queryArgs, raw);
  const accountId = ctx.account(raw);
  const sort: EmailSort[] = (args.sort ?? []).map((s) => {
    if (!SORT_PROPERTIES.has(s.property)) {
      throw new MethodError("unsupportedSort", `Unsupported sort property "${s.property}"`);
    }
    // RFC 8621: isAscending defaults to true.
    return { property: s.property, isAscending: s.isAscending ?? true, keyword: s.keyword };
  });
  const limit = args.limit === undefined || args.limit === null ? null : args.limit;
  const effectiveLimit = Math.min(limit ?? MAX_QUERY_LIMIT, MAX_QUERY_LIMIT);
  const r = await ctx.stub(accountId).emailQuery({
    filter: args.filter ? normalizeFilter(ctx, args.filter) : null,
    sort,
    position: args.position ?? 0,
    anchor: args.anchor ? ctx.resolveId(args.anchor) : null,
    anchorOffset: args.anchorOffset ?? 0,
    limit: effectiveLimit,
    collapseThreads: args.collapseThreads ?? false,
    calculateTotal: args.calculateTotal ?? false,
  });
  if (!r.ok) throw new MethodError(r.error.type, r.error.description);
  return {
    accountId,
    queryState: r.queryState,
    canCalculateChanges: false,
    position: r.position,
    ids: r.ids,
    ...(r.total !== null ? { total: r.total } : {}),
    ...(limit !== null && limit > MAX_QUERY_LIMIT ? { limit: MAX_QUERY_LIMIT } : {}),
  };
}

/** Collects text/subject/body search terms from a filter tree (ignores NOT branches). */
function collectTerms(f: unknown, out: string[]): void {
  const obj = asRecord(f);
  if (!obj) return;
  if (Array.isArray(obj.conditions)) {
    if (obj.operator !== "NOT") obj.conditions.forEach((c) => collectTerms(c, out));
    return;
  }
  for (const k of ["text", "subject", "body"]) {
    if (typeof obj[k] === "string") out.push(obj[k] as string);
  }
}

const snippetArgs = z.object({
  accountId: z.string(),
  filter: z.record(z.string(), z.unknown()).nullable().optional(),
  emailIds: idList.optional(),
});

/** Converts the store's private-use markers to escaped HTML with <mark>. */
function markup(text: string | null): string | null {
  if (text === null) return null;
  return escapeHtml(text).replace(//g, "<mark>").replace(//g, "</mark>");
}

async function searchSnippet(ctx: MethodContext, raw: Record<string, unknown>) {
  const args = parseArgs(snippetArgs, raw);
  const accountId = ctx.account(raw);
  const emailIds = (args.emailIds ?? []).map((i) => ctx.resolveId(i));
  checkCount(emailIds.length, LIMITS.maxObjectsInGet, "emailIds");
  const terms: string[] = [];
  collectTerms(args.filter, terms);
  const fts = buildFtsQuery(terms.join(" "));
  const rows = await ctx.stub(accountId).emailSnippets(emailIds, fts);
  const found = new Set(rows.map((r) => r.emailId));
  return {
    accountId,
    list: rows.map((r) => ({
      emailId: r.emailId,
      subject: markup(r.subject),
      preview: markup(r.preview),
    })),
    notFound: emailIds.filter((i) => !found.has(i)),
  };
}

export const emailQueryMethods: Record<string, MethodDef> = {
  "Email/query": { capability: CAP_MAIL, handler: emailQuery },
  "Email/queryChanges": {
    capability: CAP_MAIL,
    handler: async () => {
      throw new MethodError(
        "cannotCalculateChanges",
        "queryChanges is not supported; re-run the query",
      );
    },
  },
  "SearchSnippet/get": { capability: CAP_MAIL, handler: searchSnippet },
};
