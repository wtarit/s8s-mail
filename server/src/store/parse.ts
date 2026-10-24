import PostalMime from "postal-mime";
import { partBlobId } from "./blob";
import type { BodyPart } from "./types";

/** RFC 8621 §4.1.4: Email.preview is at most 256 characters. */
export const PREVIEW_MAX_CHARS = 256;
/** Cap on text copied into the FTS index (bounds both CPU and DO storage per message). */
export const FTS_BODY_MAX_CHARS = 32_768;

/** A decoded part whose content should be materialized in R2 under `partBlobId`. */
export type ParsedPart = {
  partId: string;
  type: string;
  content: string | ArrayBuffer | Uint8Array;
};

export type ParsedBody = {
  preview: string;
  hasAttachment: boolean;
  bodyStructure: BodyPart;
  textBody: BodyPart[];
  htmlBody: BodyPart[];
  attachments: BodyPart[];
  /** Text for the FTS index (capped). */
  ftsBody: string;
  /** Decoded part contents, in partId order. */
  parts: ParsedPart[];
};

const encoder = new TextEncoder();

function byteLength(content: string | ArrayBuffer | Uint8Array): number {
  return typeof content === "string" ? encoder.encode(content).byteLength : content.byteLength;
}

/** Whitespace-collapsed, trimmed, cut to `max` code points (never splits a surrogate pair). */
export function makePreview(text: string, max = PREVIEW_MAX_CHARS): string {
  const collapsed = text.replace(/\s+/g, " ").trim();
  if (collapsed.length <= max) return collapsed;
  let out = "";
  let n = 0;
  for (const ch of collapsed) {
    if (n === max) break;
    out += ch;
    n++;
  }
  return out;
}

const HTML_SCAN_MAX_CHARS = 65_536;
const NAMED_ENTITIES: Record<string, string> = {
  nbsp: " ",
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
};

/**
 * Cheap HTML -> text for previews and the FTS index of HTML-only messages (not a renderer).
 * Only the first 64 KiB of markup is scanned to bound CPU.
 */
export function htmlToPlain(html: string): string {
  return html
    .slice(0, HTML_SCAN_MAX_CHARS)
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<(style|script|head)\b[\s\S]*?<\/\1\s*>/gi, " ")
    .replace(/<[^>]*>/g, " ")
    .replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
      if (e[0] === "#") {
        const code =
          e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
        return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : " ";
      }
      return NAMED_ENTITIES[e.toLowerCase()] ?? m;
    });
}

function multipart(type: string, subParts: BodyPart[]): BodyPart {
  return {
    partId: null,
    blobId: null,
    size: 0,
    type,
    charset: null,
    name: null,
    disposition: null,
    cid: null,
    subParts,
  };
}

/**
 * Parses a raw RFC 5322 message with postal-mime and derives everything the account DO
 * stores for it. This is the CPU-heavy step, so it only ever runs from the DO alarm, never
 * from `email()`.
 *
 * postal-mime exposes decoded `text`, `html` and a flat `attachments` list, but neither the
 * MIME tree nor byte offsets; see BodyPart in ./types.ts for the resulting (synthesized)
 * structure and partId scheme. A message with only one of text/html gets only that part
 * (textBody/htmlBody then both point at it, as JMAP specifies).
 */
export async function parseMessage(
  raw: ReadableStream<Uint8Array>,
  messageBlobId: string,
): Promise<ParsedBody> {
  const email = await new PostalMime().parse(raw);
  const parts: ParsedPart[] = [];

  const leaf = (
    partId: string,
    type: string,
    content: string | ArrayBuffer | Uint8Array,
    extra: Partial<Pick<BodyPart, "name" | "disposition" | "cid">> = {},
  ): BodyPart => {
    parts.push({ partId, type, content });
    return {
      partId,
      blobId: partBlobId(messageBlobId, partId),
      size: byteLength(content),
      type,
      charset: typeof content === "string" ? "utf-8" : null,
      name: extra.name ?? null,
      disposition: extra.disposition ?? null,
      cid: extra.cid ?? null,
      subParts: null,
    };
  };

  const text = email.text;
  const html = email.html;
  const textPart = text !== undefined ? leaf("1", "text/plain", text) : null;
  const htmlPart = html !== undefined ? leaf("2", "text/html", html) : null;

  const attachments = email.attachments.map((a, i) =>
    leaf(String(3 + i), a.mimeType || "application/octet-stream", a.content, {
      name: a.filename,
      disposition: a.disposition,
      cid: a.contentId ? a.contentId.replace(/^<|>$/g, "") : null,
    }),
  );

  const bodyParts = [textPart, htmlPart].filter((p): p is BodyPart => p !== null);
  // A message without any text still gets an (empty) text part so textBody is never empty.
  const body: BodyPart =
    bodyParts.length === 0
      ? leaf("1", "text/plain", "")
      : bodyParts.length === 1
        ? bodyParts[0]!
        : multipart("multipart/alternative", bodyParts);
  const bodyStructure =
    attachments.length > 0 ? multipart("multipart/mixed", [body, ...attachments]) : body;

  // JMAP textBody/htmlBody fall back to the other representation when one is missing.
  const textBody = textPart ?? htmlPart ?? body;
  const htmlBody = htmlPart ?? textBody;

  // postal-mime does not derive `text` from HTML, so index/preview the stripped markup.
  const plain = text ?? (html !== undefined ? htmlToPlain(html) : "");
  return {
    preview: makePreview(plain),
    // Related (cid-referenced inline) parts are part of the body, not attachments.
    hasAttachment: email.attachments.some((a) => !a.related),
    bodyStructure,
    textBody: [textBody],
    htmlBody: [htmlBody],
    attachments,
    ftsBody: plain.length > FTS_BODY_MAX_CHARS ? plain.slice(0, FTS_BODY_MAX_CHARS) : plain,
    parts,
  };
}
