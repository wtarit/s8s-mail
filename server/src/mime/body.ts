import {
  base64Lines,
  foldHeader,
  isAscii,
  paramTokens,
  qpEncode,
  semicolons,
  utf8,
} from "./encode";
import type { EmailAttachmentInput } from "./types";

// ---------- body tree ----------

export type Node =
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

export function attachmentNode(a: EmailAttachmentInput, data: Uint8Array): AttNode {
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
export function emit(
  node: Node,
  pre: string,
  out: Uint8Array[],
  texts: string[],
  top: boolean,
): void {
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

export function randomHex(bytes: number): string {
  const a = crypto.getRandomValues(new Uint8Array(bytes));
  let s = "";
  for (const b of a) s += (b < 16 ? "0" : "") + b.toString(16);
  return s;
}

/** Random boundary that does not occur in any text part (binary parts are base64). */
function makeBoundary(texts: string[]): string {
  for (let i = 0; ; i++) {
    const b = `=_s8s_${randomHex(12)}`;
    if (i >= 8 || !texts.some((t) => t.includes(b))) return b;
  }
}
