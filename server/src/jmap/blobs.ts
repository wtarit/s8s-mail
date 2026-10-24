/** Blob upload and download (RFC 8620 §6). Blobs live in R2 at `${accountId}/${blobId}`. */
import type { Context } from "hono";
import { parseMessage } from "../store/parse";
import { blobKey, parseBlobId, randomHex } from "../store/blob";
import { REQUEST_ERRORS, RequestError } from "./errors";
import { attachmentLimit } from "./session";
import type { JmapEnv } from "./types";
import { ID_RE } from "./util";

const MEDIA_TYPE_RE = /^[A-Za-z0-9!#$&^_.+-]+\/[A-Za-z0-9!#$&^_.+-]+$/;
/** Part blobs that were never materialized are re-parsed from the raw message up to this size. */
const REPARSE_MAX_RAW_BYTES = 1024 * 1024;

function problem(
  status: number,
  type: string,
  detail: string,
  extra: Record<string, unknown> = {},
) {
  return new RequestError(type, status, detail, extra).toResponse();
}

/** Account check for blob endpoints: unknown/foreign accounts are 404 (do not leak existence). */
function accountParam(c: Context<JmapEnv>): string | null {
  const accountId = c.req.param("accountId");
  return accountId && c.get("principal").accountIds.includes(accountId) ? accountId : null;
}

export function newUploadBlobId(): string {
  return `U${randomHex(16)}`;
}

/** `POST /jmap/upload/:accountId/` */
export async function handleUpload(c: Context<JmapEnv>): Promise<Response> {
  const accountId = accountParam(c);
  if (!accountId) return problem(404, "about:blank", "Account not found");
  const limit = attachmentLimit(c.env);
  const tooBig = () =>
    problem(413, REQUEST_ERRORS.limit, `Upload exceeds ${limit} bytes`, { limit: "maxSizeUpload" });
  const type = c.req.header("content-type")?.split(";")[0]?.trim() || "application/octet-stream";
  const contentType = MEDIA_TYPE_RE.test(type) ? type : "application/octet-stream";
  const declared = c.req.header("content-length");
  const body = c.req.raw.body;
  const blobId = newUploadBlobId();
  const key = blobKey(accountId, blobId);

  let size: number;
  if (declared !== undefined && /^\d+$/.test(declared)) {
    size = Number(declared);
    if (size > limit) return tooBig();
    if (size === 0 || !body) {
      await c.env.BLOBS.put(key, new Uint8Array(0), { httpMetadata: { contentType } });
      size = 0;
    } else {
      const { readable, writable } = new FixedLengthStream(size);
      await Promise.all([
        c.env.BLOBS.put(key, readable, { httpMetadata: { contentType } }),
        body.pipeTo(writable),
      ]);
    }
  } else {
    // Unknown length (chunked): buffer up to the limit.
    const chunks: Uint8Array[] = [];
    size = 0;
    if (body) {
      const reader = body.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > limit) {
          await reader.cancel();
          return tooBig();
        }
        chunks.push(value);
      }
    }
    const all = new Uint8Array(size);
    let off = 0;
    for (const ch of chunks) {
      all.set(ch, off);
      off += ch.byteLength;
    }
    await c.env.BLOBS.put(key, all, { httpMetadata: { contentType } });
  }
  return c.json({ accountId, blobId, type: contentType, size }, 201);
}

/** RFC 6266 Content-Disposition with an ASCII fallback and an RFC 5987 `filename*`. */
export function contentDisposition(name: string): string {
  const clean = name.replace(/[\r\n]/g, " ").slice(0, 255) || "download";
  const ascii = clean.replace(/[^\x20-\x7e]|["\\%]/g, "_");
  const encoded = encodeURIComponent(clean).replace(
    /['()*]/g,
    (ch) => `%${ch.charCodeAt(0).toString(16).toUpperCase()}`,
  );
  return /^[\x20-\x7e]*$/.test(clean) && !/["\\%]/.test(clean)
    ? `attachment; filename="${clean}"`
    : `attachment; filename="${ascii}"; filename*=UTF-8''${encoded}`;
}

/** Re-parses the raw message to serve a part blob that is missing from R2. */
async function reparsePart(env: Env, accountId: string, blobId: string) {
  const m = /^(M[0-9a-f]{32})-(\d+)$/.exec(blobId);
  if (!m) return null;
  const raw = await env.BLOBS.get(blobKey(accountId, m[1]!));
  if (!raw || raw.size > REPARSE_MAX_RAW_BYTES) return null;
  const parsed = await parseMessage(raw.body, m[1]!);
  const part = parsed.parts.find((p) => p.partId === m[2]);
  if (!part) return null;
  const bytes =
    typeof part.content === "string"
      ? new TextEncoder().encode(part.content)
      : new Uint8Array(part.content);
  return { bytes, type: part.type };
}

/** `GET /jmap/download/:accountId/:blobId/:name?type=` */
export async function handleDownload(c: Context<JmapEnv>): Promise<Response> {
  const accountId = accountParam(c);
  const blobId = c.req.param("blobId");
  if (!accountId || !blobId || !ID_RE.test(blobId)) {
    return problem(404, "about:blank", "Blob not found");
  }
  const requested = c.req.query("type")?.split(";")[0]?.trim();
  const headers = new Headers({
    "Content-Disposition": contentDisposition(c.req.param("name") ?? "download"),
    // Blob ids never change content: safe to cache privately for good.
    "Cache-Control": "private, immutable, max-age=31536000",
    // Attachments are untrusted content on the app origin: never sniffed or rendered inline.
    "X-Content-Type-Options": "nosniff",
    "Content-Security-Policy": "sandbox; default-src 'none'",
  });
  const obj = await c.env.BLOBS.get(blobKey(accountId, blobId));
  if (obj) {
    const type =
      requested && MEDIA_TYPE_RE.test(requested)
        ? requested
        : (obj.httpMetadata?.contentType?.split(";")[0] ?? "application/octet-stream");
    headers.set("Content-Type", type);
    headers.set("Content-Length", String(obj.size));
    return new Response(obj.body, { headers });
  }
  const { messageBlobId, partId } = parseBlobId(blobId);
  if (partId !== null && messageBlobId.length > 0) {
    const part = await reparsePart(c.env, accountId, blobId);
    if (part) {
      headers.set(
        "Content-Type",
        requested && MEDIA_TYPE_RE.test(requested) ? requested : part.type,
      );
      headers.set("Content-Length", String(part.bytes.byteLength));
      return new Response(part.bytes, { headers });
    }
  }
  return problem(404, "about:blank", "Blob not found");
}
