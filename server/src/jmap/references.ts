import { MethodError } from "./errors";
import type { Invocation } from "./types";
import { unescapePointerToken } from "./util";

type Result = { ok: true; value: unknown } | { ok: false };

function walk(value: unknown, tokens: string[], i: number): Result {
  if (i === tokens.length) return { ok: true, value };
  const token = tokens[i]!;
  if (token === "*") {
    if (!Array.isArray(value)) return { ok: false };
    const out: unknown[] = [];
    for (const item of value) {
      const r = walk(item, tokens, i + 1);
      if (!r.ok) return r;
      if (Array.isArray(r.value)) out.push(...r.value);
      else out.push(r.value);
    }
    return { ok: true, value: out };
  }
  if (Array.isArray(value)) {
    if (!/^\d+$/.test(token)) return { ok: false };
    const item = value[Number(token)];
    return item === undefined ? { ok: false } : walk(item, tokens, i + 1);
  }
  if (value !== null && typeof value === "object") {
    const key = unescapePointerToken(token);
    const obj = value as Record<string, unknown>;
    return Object.hasOwn(obj, key) ? walk(obj[key], tokens, i + 1) : { ok: false };
  }
  return { ok: false };
}

/** Evaluates a JSON Pointer (RFC 6901) with the `*` array extension of RFC 8620 §3.7. */
export function evaluatePointer(root: unknown, path: string): Result {
  if (path === "") return { ok: true, value: root };
  if (!path.startsWith("/")) return { ok: false };
  return walk(root, path.slice(1).split("/"), 0);
}

/**
 * Replaces `#prop` arguments (ResultReference objects) by the referenced values from
 * earlier method responses. Throws invalidArguments / invalidResultReference.
 */
export function resolveResultReferences(
  args: Record<string, unknown>,
  previous: readonly Invocation[],
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(args)) {
    if (!key.startsWith("#")) {
      if (!(key in out)) out[key] = value;
      continue;
    }
    const prop = key.slice(1);
    if (Object.hasOwn(args, prop)) {
      throw new MethodError("invalidArguments", `Both "${prop}" and "#${prop}" are present`);
    }
    const ref = value as { resultOf?: unknown; name?: unknown; path?: unknown } | null;
    if (
      ref === null ||
      typeof ref !== "object" ||
      typeof ref.resultOf !== "string" ||
      typeof ref.name !== "string" ||
      typeof ref.path !== "string"
    ) {
      throw new MethodError("invalidArguments", `"#${prop}" is not a valid ResultReference`);
    }
    const source = previous.find((r) => r[2] === ref.resultOf && r[0] === ref.name);
    if (!source) {
      throw new MethodError(
        "invalidResultReference",
        `No earlier "${String(ref.name)}" response with call id "${ref.resultOf}"`,
      );
    }
    const r = evaluatePointer(source[1], ref.path);
    if (!r.ok) {
      throw new MethodError("invalidResultReference", `Path "${ref.path}" does not resolve`);
    }
    out[prop] = r.value;
  }
  return out;
}
