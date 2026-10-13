import {
  base64Lines,
  concat,
  foldHeader,
  isAscii,
  oneLine,
  paramTokens,
  phraseTokens,
  qpEncode,
  semicolons,
  unstructuredTokens,
  utf8,
} from "./encode";
import type {
  BuildMimeOptions,
  BuiltMime,
  EmailAddress,
  EmailAttachmentInput,
  EmailCreate,
} from "./types";
import { BlobNotFoundError, MimeBuildError } from "./types";

/**
 * Builds an RFC 5322 / MIME message from a JMAP `Email/set` create object.
 *
 * Structure (RFC 8621 §4.6), empty levels omitted:
 *
 *   multipart/mixed
 *   ├─ multipart/alternative
 *   │  ├─ text/plain
 *   │  └─ multipart/related
 *   │     ├─ text/html
 *   │     └─ inline parts that have a Content-ID
 *   └─ regular attachments (and inline parts that cannot be `related`)
 *
 * The whole message is assembled as a list of byte chunks and concatenated once.
 * Attachment bytes are held in memory (blob + final message) — see `maxAttachmentBytes`.
 */
export async function buildMime(email: EmailCreate, options: BuildMimeOptions): Promise<BuiltMime> {
  const now = options.now ?? new Date();
  const from = addresses(email.from, "from");
  if (from.length === 0) throw new MimeBuildError("At least one From address is required", "from");
  const to = addresses(email.to, "to");
  const cc = addresses(email.cc, "cc");
  const bcc = addresses(email.bcc, "bcc");
  const replyTo = addresses(email.replyTo, "replyTo");
  const sender = addresses(email.sender, "sender");

  // --- message id ---
  const given = msgIds(email.messageId)[0];
  const messageId = given ?? generateMessageId(options.messageIdDomain);

  // --- headers ---
  let h = "";
  h += foldHeader("Date", [formatDate(parseDate(email.sentAt) ?? now)]);
  h += foldHeader("From", addressTokens(from));
  if (sender.length) h += foldHeader("Sender", addressTokens(sender));
  if (replyTo.length) h += foldHeader("Reply-To", addressTokens(replyTo));
  if (to.length) h += foldHeader("To", addressTokens(to));
  if (cc.length) h += foldHeader("Cc", addressTokens(cc));
  if (options.includeBcc && bcc.length) h += foldHeader("Bcc", addressTokens(bcc));
  h += foldHeader("Subject", unstructuredTokens(email.subject ?? ""));
  h += foldHeader("Message-ID", [`<${messageId}>`]);
  const inReplyTo = msgIds(email.inReplyTo);
  if (inReplyTo.length)
    h += foldHeader(
      "In-Reply-To",
      inReplyTo.map((i) => `<${i}>`),
    );
  const references = msgIds(email.references);
  if (references.length)
    h += foldHeader(
      "References",
      references.map((i) => `<${i}>`),
    );
  h += extraHeaders(email.headers);
  h += "MIME-Version: 1.0\r\n";

  // --- body tree ---
  const values = email.bodyValues ?? {};
  const resolve = (refs: EmailCreate["textBody"], prop: string): string | null => {
    if (!refs || refs.length === 0) return null;
    let text = "";
    refs.forEach((ref, idx) => {
      const v = values[ref.partId];
      if (!v || typeof v.value !== "string") {
        throw new MimeBuildError(`No bodyValue for partId "${ref.partId}"`, prop);
      }
      text += (idx ? "\n" : "") + v.value;
    });
    return text;
  };
  let plain = resolve(email.textBody, "textBody");
  let html = resolve(email.htmlBody, "htmlBody");
  // A textBody that is declared text/html and has no htmlBody counterpart is the HTML body.
  if (html === null && plain !== null && email.textBody?.[0]?.type?.toLowerCase() === "text/html") {
    html = plain;
    plain = null;
  }

  const attachments = email.attachments ?? [];
  const blobs = await Promise.all(
    attachments.map(async (a) => {
      const data = await options.fetchBlob(a.blobId);
      if (!data) throw new BlobNotFoundError(a.blobId);
      return data;
    }),
  );

  const related: Node[] = [];
  const regular: Node[] = [];
  attachments.forEach((a, idx) => {
    const node = attachmentNode(a, blobs[idx]!);
    if (html !== null && node.disposition === "inline" && node.cid) related.push(node);
    else regular.push(node);
  });

  const texts: string[] = [];
  if (plain !== null) texts.push(plain);
  if (html !== null) texts.push(html);

  let body: Node;
  const htmlNode: Node | null =
    html === null
      ? null
      : related.length
        ? {
            t: "multi",
            subtype: "related",
            children: [{ t: "text", subtype: "html", text: html }, ...related],
          }
        : { t: "text", subtype: "html", text: html };
  if (htmlNode && plain !== null) {
    body = {
      t: "multi",
      subtype: "alternative",
      children: [{ t: "text", subtype: "plain", text: plain }, htmlNode],
    };
  } else if (htmlNode) {
    body = htmlNode;
  } else {
    body = { t: "text", subtype: "plain", text: plain ?? "" };
  }
  if (regular.length) body = { t: "multi", subtype: "mixed", children: [body, ...regular] };

  // --- assemble ---
  const chunks: Uint8Array[] = [];
  emit(body, h, chunks, texts, true);
  const raw = concat(chunks);
  return { raw, messageId, size: raw.length };
}

// ---------- body tree ----------

type Node =
  | { t: "text"; subtype: "plain" | "html"; text: string }
  | {
      t: "att";
      type: string;
      name: string | null;
      disposition: "attachment" | "inline";
      cid: string | null;
      data: Uint8Array;
    }
  | { t: "multi"; subtype: "mixed" | "alternative" | "related"; children: Node[] };

type AttNode = Extract<Node, { t: "att" }>;

const CONTENT_TYPE = /^[A-Za-z0-9][A-Za-z0-9!#$&^_.+-]*\/[A-Za-z0-9][A-Za-z0-9!#$&^_.+-]*$/;

function attachmentNode(a: EmailAttachmentInput, data: Uint8Array): AttNode {
  const type = CONTENT_TYPE.test(a.type ?? "") ? a.type.toLowerCase() : "application/octet-stream";
  const cid = a.cid ? a.cid.replace(/[^\x21-\x7e]|[<>]/g, "") : "";
  return {
    t: "att",
    type,
    name: a.name ? a.name : null,
    disposition: a.disposition?.toLowerCase() === "inline" ? "inline" : "attachment",
    cid: cid || null,
    data,
  };
}

/** Writes `pre` (message headers, top level only) + the node's headers + blank line + body. */
function emit(node: Node, pre: string, out: Uint8Array[], texts: string[], top: boolean): void {
  if (node.t === "text") {
    const { cte, bytes } = encodeText(node.text);
    out.push(
      utf8(
        pre +
          foldHeader("Content-Type", [`text/${node.subtype};`, "charset=utf-8"]) +
          `Content-Transfer-Encoding: ${cte}\r\n\r\n`,
      ),
      bytes,
    );
    // Top-level single part: end the message with CRLF. In multiparts the CRLF belongs to
    // the following delimiter.
    if (top && !endsWithCrlf(bytes)) out.push(CRLF);
    return;
  }
  if (node.t === "att") {
    let hh = pre;
    hh += foldHeader(
      "Content-Type",
      semicolons([node.type, ...(node.name ? paramTokens("name", node.name) : [])]),
    );
    hh += "Content-Transfer-Encoding: base64\r\n";
    hh += foldHeader(
      "Content-Disposition",
      semicolons([node.disposition, ...(node.name ? paramTokens("filename", node.name) : [])]),
    );
    if (node.cid) hh += foldHeader("Content-ID", [`<${node.cid}>`]);
    out.push(utf8(hh + "\r\n"), base64Lines(node.data));
    return;
  }
  const boundary = makeBoundary(texts);
  out.push(
    utf8(
      pre +
        foldHeader("Content-Type", [`multipart/${node.subtype};`, `boundary="${boundary}"`]) +
        "\r\n",
    ),
  );
  for (const child of node.children) {
    out.push(utf8(`--${boundary}\r\n`));
    emit(child, "", out, texts, false);
    out.push(CRLF);
  }
  out.push(utf8(`--${boundary}--\r\n`));
}

const CRLF = new Uint8Array([13, 10]);

function endsWithCrlf(b: Uint8Array): boolean {
  return b.length >= 2 && b[b.length - 2] === 13 && b[b.length - 1] === 10;
}

const LONG_LINE = 78;

/** Normalises line endings to CRLF and picks 7bit (short ASCII lines) or quoted-printable. */
function encodeText(text: string): { cte: "7bit" | "quoted-printable"; bytes: Uint8Array } {
  const norm = text.replace(/\r\n|\r|\n/g, "\r\n");
  if (isAscii(norm) && !norm.includes("\0") && maxLineLength(norm) <= LONG_LINE) {
    return { cte: "7bit", bytes: utf8(norm) };
  }
  return { cte: "quoted-printable", bytes: qpEncode(utf8(norm)) };
}

function maxLineLength(s: string): number {
  let max = 0;
  let pos = 0;
  for (;;) {
    const nl = s.indexOf("\r\n", pos);
    const end = nl < 0 ? s.length : nl;
    if (end - pos > max) max = end - pos;
    if (nl < 0) return max;
    pos = nl + 2;
  }
}

function hex(bytes: number): string {
  const a = crypto.getRandomValues(new Uint8Array(bytes));
  let s = "";
  for (const b of a) s += (b < 16 ? "0" : "") + b.toString(16);
  return s;
}

/** Random boundary that does not occur in any text part (binary parts are base64). */
function makeBoundary(texts: string[]): string {
  for (let i = 0; ; i++) {
    const b = `=_s8s_${hex(12)}`;
    if (i >= 8 || !texts.some((t) => t.includes(b))) return b;
  }
}

function generateMessageId(domain: string): string {
  const d = domain.replace(/[^\x21-\x7e]|[<>]/g, "") || "localhost";
  return `${Date.now().toString(36)}.${hex(10)}@${d}`;
}

// ---------- headers ----------

const ADDR = /^[^\s<>",;:()[\]\\@]+@[^\s<>",;:()[\]\\@]+$/;

function validateEmail(raw: string, prop: string): string {
  let email = typeof raw === "string" ? raw.trim() : "";
  if (!isAscii(email)) {
    const at = email.lastIndexOf("@");
    // Internationalised domains are sent as punycode; non-ASCII local parts need SMTPUTF8.
    if (at > 0 && isAscii(email.slice(0, at))) {
      try {
        email = email.slice(0, at + 1) + new URL("http://" + email.slice(at + 1)).hostname;
      } catch {
        /* fall through to the validity check below */
      }
    }
  }
  if (!ADDR.test(email) || !isAscii(email)) {
    throw new MimeBuildError(`Invalid email address "${oneLine(String(raw))}"`, prop);
  }
  return email;
}

function addresses(list: EmailAddress[] | null | undefined, prop: string): EmailAddress[] {
  if (!list) return [];
  return list.map((a) => ({ name: a.name ?? null, email: validateEmail(a.email, prop) }));
}

function addressTokens(list: EmailAddress[]): string[] {
  const tokens: string[] = [];
  list.forEach((a, idx) => {
    const phrase = a.name ? phraseTokens(a.name) : [];
    const toks = phrase.length ? [...phrase, `<${a.email}>`] : [a.email];
    if (idx < list.length - 1) toks[toks.length - 1] += ",";
    tokens.push(...toks);
  });
  return tokens;
}

function msgIds(v: string | string[] | null | undefined): string[] {
  if (!v) return [];
  const list = Array.isArray(v) ? v : v.split(/\s+/);
  const out: string[] = [];
  for (const raw of list) {
    const id = String(raw).replace(/[^\x21-\x7e]|[<>]/g, "");
    if (id) out.push(id);
  }
  return out;
}

const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function pad(n: number): string {
  return n < 10 ? "0" + n : String(n);
}

function parseDate(s: string | null | undefined): Date | null {
  if (!s) return null;
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d;
}

export function formatDate(d: Date): string {
  return (
    `${DAYS[d.getUTCDay()]}, ${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()} ` +
    `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())} +0000`
  );
}

/** Headers the builder emits itself; client-supplied duplicates are dropped. */
const RESERVED = new Set([
  "date",
  "from",
  "sender",
  "reply-to",
  "to",
  "cc",
  "bcc",
  "subject",
  "message-id",
  "in-reply-to",
  "references",
  "mime-version",
  "return-path",
]);

function extraHeaders(input: EmailCreate["headers"]): string {
  if (!input) return "";
  const list = Array.isArray(input)
    ? input
    : Object.entries(input).map(([name, value]) => ({ name, value }));
  let out = "";
  for (const { name, value } of list) {
    if (!/^[A-Za-z0-9-]{1,100}$/.test(name)) continue;
    const lower = name.toLowerCase();
    if (RESERVED.has(lower) || lower.startsWith("content-")) continue;
    out += foldHeader(name, unstructuredTokens(String(value)));
  }
  return out;
}
