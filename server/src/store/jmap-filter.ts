/**
 * Email/query filter and sort compilation (RFC 8621 §4.4) to SQL over `email e`.
 * Pure functions: the DO runs the result. All user input is bound as parameters.
 */
import type { EmailCondition, EmailFilter, EmailSort } from "./jmap-types";

export type SqlValue = string | number | null;
export type Fragment = { sql: string; params: SqlValue[] };

/** Thrown for filters/sorts the store cannot evaluate; the DO maps it to a JMAP error. */
export class QueryError extends Error {
  constructor(
    readonly type: "unsupportedFilter" | "unsupportedSort" | "invalidArguments",
    message: string,
  ) {
    super(message);
    this.name = "QueryError";
  }
}

const MAX_DEPTH = 16;
const MAX_NODES = 200;

/** `%needle%` for LIKE ... ESCAPE '\'. */
function likePattern(needle: string): string {
  return `%${needle.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
}

/**
 * Builds an FTS5 MATCH expression from user text: words and "quoted phrases" are ANDed,
 * a trailing `*` makes the last token a prefix match, punctuation is dropped (as the
 * unicode61 tokenizer would). Returns null when there is nothing to match.
 */
export function buildFtsQuery(text: string, column?: string): string | null {
  const terms: string[] = [];
  const re = /"([^"]*)"|(\S+)/g;
  for (let m = re.exec(text); m !== null; m = re.exec(text)) {
    const phrase = m[1] !== undefined;
    const raw = (m[1] ?? m[2])!;
    const prefix = !phrase && raw.endsWith("*");
    const tokens = raw.match(/[\p{L}\p{N}]+/gu);
    if (!tokens) continue;
    terms.push(`"${tokens.join(" ")}"${prefix ? " *" : ""}`);
  }
  if (terms.length === 0) return null;
  const expr = terms.join(" AND ");
  return column ? `${column} : (${expr})` : expr;
}

function addressLike(column: "from" | "to" | "cc" | "bcc", needle: string): Fragment {
  const p = likePattern(needle);
  return {
    sql: `EXISTS (SELECT 1 FROM json_each(e."${column}") j WHERE json_extract(j.value, '$.name') LIKE ? ESCAPE '\\' OR json_extract(j.value, '$.email') LIKE ? ESCAPE '\\')`,
    params: [p, p],
  };
}

function kwExists(keyword: string, emailRef: string): Fragment {
  return {
    sql: `EXISTS (SELECT 1 FROM email_keyword k WHERE k.email_id = ${emailRef} AND k.keyword = ?)`,
    params: [keyword.toLowerCase()],
  };
}

const HEADER_COLUMNS: Record<string, string> = {
  subject: "subject",
  "message-id": "message_id",
  from: '"from"',
  to: '"to"',
  cc: "cc",
  bcc: "bcc",
  "reply-to": "reply_to",
  sender: "sender",
  "in-reply-to": "in_reply_to",
  references: '"references"',
};

function conditionFragments(c: EmailCondition): Fragment[] {
  const out: Fragment[] = [];
  const add = (sql: string, ...params: SqlValue[]) => out.push({ sql, params });
  const known = new Set([
    "inMailbox",
    "inMailboxOtherThan",
    "before",
    "after",
    "minSize",
    "maxSize",
    "allInThreadHaveKeyword",
    "someInThreadHaveKeyword",
    "noneInThreadHaveKeyword",
    "hasKeyword",
    "notKeyword",
    "hasAttachment",
    "text",
    "from",
    "to",
    "cc",
    "bcc",
    "subject",
    "body",
    "header",
  ]);
  for (const key of Object.keys(c)) {
    if (!known.has(key)) throw new QueryError("unsupportedFilter", `Unsupported filter "${key}"`);
  }
  if (c.inMailbox !== undefined) {
    add(
      "EXISTS (SELECT 1 FROM email_mailbox m WHERE m.email_id = e.id AND m.mailbox_id = ?)",
      c.inMailbox,
    );
  }
  if (c.inMailboxOtherThan !== undefined) {
    add(
      "EXISTS (SELECT 1 FROM email_mailbox m WHERE m.email_id = e.id AND m.mailbox_id NOT IN (SELECT value FROM json_each(?)))",
      JSON.stringify(c.inMailboxOtherThan),
    );
  }
  if (c.before !== undefined) add("e.received_at < ?", c.before);
  if (c.after !== undefined) add("e.received_at >= ?", c.after);
  if (c.minSize !== undefined) add("e.size >= ?", c.minSize);
  if (c.maxSize !== undefined) add("e.size < ?", c.maxSize);
  if (c.hasKeyword !== undefined) out.push(kwExists(c.hasKeyword, "e.id"));
  if (c.notKeyword !== undefined) {
    const f = kwExists(c.notKeyword, "e.id");
    out.push({ sql: `NOT ${f.sql}`, params: f.params });
  }
  if (c.someInThreadHaveKeyword !== undefined) {
    add(
      "EXISTS (SELECT 1 FROM email t JOIN email_keyword k ON k.email_id = t.id WHERE t.thread_id = e.thread_id AND k.keyword = ?)",
      c.someInThreadHaveKeyword.toLowerCase(),
    );
  }
  if (c.noneInThreadHaveKeyword !== undefined) {
    add(
      "NOT EXISTS (SELECT 1 FROM email t JOIN email_keyword k ON k.email_id = t.id WHERE t.thread_id = e.thread_id AND k.keyword = ?)",
      c.noneInThreadHaveKeyword.toLowerCase(),
    );
  }
  if (c.allInThreadHaveKeyword !== undefined) {
    add(
      "NOT EXISTS (SELECT 1 FROM email t WHERE t.thread_id = e.thread_id AND NOT EXISTS (SELECT 1 FROM email_keyword k WHERE k.email_id = t.id AND k.keyword = ?))",
      c.allInThreadHaveKeyword.toLowerCase(),
    );
  }
  if (c.hasAttachment !== undefined) add("e.has_attachment = ?", c.hasAttachment ? 1 : 0);
  for (const field of ["from", "to", "cc", "bcc"] as const) {
    const needle = c[field];
    if (needle !== undefined && needle !== "") out.push(addressLike(field, needle));
  }
  if (c.subject !== undefined && c.subject !== "") {
    add("e.subject LIKE ? ESCAPE '\\'", likePattern(c.subject));
  }
  if (c.body !== undefined) {
    const q = buildFtsQuery(c.body, "body");
    if (q) add("e.rowid IN (SELECT rowid FROM email_fts WHERE email_fts MATCH ?)", q);
  }
  if (c.text !== undefined && c.text.trim() !== "") {
    const alts: Fragment[] = [];
    const q = buildFtsQuery(c.text);
    if (q) {
      alts.push({
        sql: "e.rowid IN (SELECT rowid FROM email_fts WHERE email_fts MATCH ?)",
        params: [q],
      });
    }
    // Substring match on header fields too (works before the body parse and for bcc).
    alts.push({ sql: "e.subject LIKE ? ESCAPE '\\'", params: [likePattern(c.text.trim())] });
    for (const field of ["from", "to", "cc", "bcc"] as const) {
      alts.push(addressLike(field, c.text.trim()));
    }
    out.push({
      sql: `(${alts.map((a) => a.sql).join(" OR ")})`,
      params: alts.flatMap((a) => a.params),
    });
  }
  if (c.header !== undefined) {
    const [name, value] = c.header;
    const col = name ? HEADER_COLUMNS[name.toLowerCase()] : undefined;
    if (!col) {
      throw new QueryError(
        "unsupportedFilter",
        `header filter on "${name ?? ""}" is not supported`,
      );
    }
    const textual = `CAST(e.${col} AS TEXT)`;
    if (value === undefined || value === "") {
      add(`(e.${col} IS NOT NULL AND ${textual} NOT IN ('', '[]'))`);
    } else {
      add(`${textual} LIKE ? ESCAPE '\\'`, likePattern(value));
    }
  }
  return out;
}

/** Compiles a filter tree to a boolean SQL expression ("1" for no filter). */
export function compileFilter(filter: EmailFilter | null | undefined): Fragment {
  let nodes = 0;
  const walk = (f: EmailFilter, depth: number): Fragment => {
    if (depth > MAX_DEPTH || ++nodes > MAX_NODES) {
      throw new QueryError("unsupportedFilter", "Filter is too deeply nested or too large");
    }
    if ("operator" in f) {
      const op = f.operator;
      if (op !== "AND" && op !== "OR" && op !== "NOT") {
        throw new QueryError("unsupportedFilter", `Unknown operator "${String(op)}"`);
      }
      const parts = f.conditions.map((c) => walk(c, depth + 1));
      if (parts.length === 0) return { sql: op === "OR" ? "0" : "1", params: [] };
      const joiner = op === "OR" || op === "NOT" ? " OR " : " AND ";
      const joined = `(${parts.map((p) => p.sql).join(joiner)})`;
      return {
        sql: op === "NOT" ? `NOT ${joined}` : joined,
        params: parts.flatMap((p) => p.params),
      };
    }
    const frags = conditionFragments(f);
    if (frags.length === 0) return { sql: "1", params: [] };
    return {
      sql: `(${frags.map((p) => p.sql).join(" AND ")})`,
      params: frags.flatMap((p) => p.params),
    };
  };
  return filter ? walk(filter, 0) : { sql: "1", params: [] };
}

const SORT_NAME_EXPR = (col: string) =>
  `lower(COALESCE(NULLIF(json_extract(e."${col}", '$[0].name'), ''), json_extract(e."${col}", '$[0].email'), ''))`;

/** Compiles one comparator to a SQL value expression (RFC 8621 §4.4.2). */
export function sortExpression(sort: EmailSort): Fragment {
  switch (sort.property) {
    case "receivedAt":
      return { sql: "e.received_at", params: [] };
    case "sentAt":
      return { sql: "COALESCE(e.sent_at, e.received_at)", params: [] };
    case "size":
      return { sql: "e.size", params: [] };
    case "from":
      return { sql: SORT_NAME_EXPR("from"), params: [] };
    case "to":
      return { sql: SORT_NAME_EXPR("to"), params: [] };
    case "subject":
      // Approximation of RFC 5256 base subject: strip leading Re:/Fwd: prefixes (one level
      // of nesting is handled by repeating the pattern in JS before storing; here lower()).
      return { sql: "lower(COALESCE(e.subject, ''))", params: [] };
    case "hasKeyword":
    case "allInThreadHaveKeyword":
    case "someInThreadHaveKeyword": {
      if (!sort.keyword) {
        throw new QueryError("invalidArguments", `Sort "${sort.property}" needs a keyword`);
      }
      const kw = sort.keyword.toLowerCase();
      if (sort.property === "hasKeyword") {
        const f = kwExists(kw, "e.id");
        return { sql: `(CASE WHEN ${f.sql} THEN 1 ELSE 0 END)`, params: f.params };
      }
      if (sort.property === "someInThreadHaveKeyword") {
        return {
          sql: "(CASE WHEN EXISTS (SELECT 1 FROM email t JOIN email_keyword k ON k.email_id = t.id WHERE t.thread_id = e.thread_id AND k.keyword = ?) THEN 1 ELSE 0 END)",
          params: [kw],
        };
      }
      return {
        sql: "(CASE WHEN NOT EXISTS (SELECT 1 FROM email t WHERE t.thread_id = e.thread_id AND NOT EXISTS (SELECT 1 FROM email_keyword k WHERE k.email_id = t.id AND k.keyword = ?)) THEN 1 ELSE 0 END)",
        params: [kw],
      };
    }
    default:
      throw new QueryError("unsupportedSort", `Unsupported sort property "${sort.property}"`);
  }
}

export type CompiledQuery = {
  /** `SELECT id [, ...] FROM ...` with ordering applied; append LIMIT/OFFSET yourself. */
  idsSql: string;
  idsParams: SqlValue[];
  /** Same row set without ordering, for count(*). */
  countSql: string;
  countParams: SqlValue[];
};

/**
 * Builds the id query. Layout (uniform for collapse and non-collapse):
 *   inner:  email rows passing the filter, with the sort values as s0..sN
 *   middle: ROW_NUMBER() per thread in sort order (only when collapsing)
 *   outer:  ORDER BY the sort values, then id
 */
export function compileEmailQuery(
  filter: EmailFilter | null,
  sorts: EmailSort[],
  collapseThreads: boolean,
): CompiledQuery {
  const sortList: EmailSort[] =
    sorts.length > 0 ? sorts : [{ property: "receivedAt", isAscending: false }];
  const where = compileFilter(filter);
  const exprs = sortList.map(sortExpression);
  const selectCols = exprs.map((x, i) => `${x.sql} AS s${i}`).join(", ");
  const selectParams = exprs.flatMap((x) => x.params);
  const orderBy = (alias = "") =>
    sortList.map((s, i) => `${alias}s${i} ${s.isAscending ? "ASC" : "DESC"}`).join(", ");
  const inner = `SELECT e.id AS id, e.thread_id AS thread_id, ${selectCols} FROM email e WHERE ${where.sql}`;
  const innerParams = [...selectParams, ...where.params];

  if (!collapseThreads) {
    return {
      idsSql: `SELECT id FROM (${inner}) ORDER BY ${orderBy()}, id`,
      idsParams: innerParams,
      countSql: `SELECT count(*) AS n FROM email e WHERE ${where.sql}`,
      countParams: where.params,
    };
  }
  const ranked = `SELECT id, ${sortList.map((_, i) => `s${i}`).join(", ")}, ROW_NUMBER() OVER (PARTITION BY thread_id ORDER BY ${orderBy()}, id) AS rn FROM (${inner})`;
  return {
    idsSql: `SELECT id FROM (${ranked}) WHERE rn = 1 ORDER BY ${orderBy()}, id`,
    idsParams: innerParams,
    countSql: `SELECT count(DISTINCT e.thread_id) AS n FROM email e WHERE ${where.sql}`,
    countParams: where.params,
  };
}
