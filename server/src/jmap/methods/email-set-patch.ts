import type { EmailUpdateInput, SetOp } from "../../store/jmap-types";
import type { MethodContext } from "../context";
import type { SetError } from "../types";
import { isValidKeyword, unescapePointerToken } from "../util";

export function keywordList(map: Record<string, boolean> | null | undefined): string[] | SetError {
  const out: string[] = [];
  for (const [k, v] of Object.entries(map ?? {})) {
    if (!isValidKeyword(k)) {
      return {
        type: "invalidProperties",
        properties: ["keywords"],
        description: `Invalid keyword "${k}"`,
      };
    }
    if (v) out.push(k.toLowerCase());
  }
  return out;
}

const invalid = (key: string, description: string): SetError => ({
  type: "invalidProperties",
  properties: [key],
  description,
});

/** Turns a PatchObject (or full-value update) into store operations. */
export function parseUpdate(
  ctx: MethodContext,
  id: string,
  patch: Record<string, unknown>,
): EmailUpdateInput | SetError {
  const op: EmailUpdateInput = { id };
  const kw: SetOp = {};
  const mb: SetOp = {};
  let kwWhole = false;
  let kwPatch = false;
  let mbWhole = false;
  let mbPatch = false;
  for (const [key, value] of Object.entries(patch)) {
    if (key === "keywords") {
      const list = keywordList(value as Record<string, boolean>);
      if (!Array.isArray(list) || value === null || typeof value !== "object") {
        return Array.isArray(list) ? invalid(key, "keywords must be an object") : list;
      }
      kw.set = list;
      kwWhole = true;
    } else if (key.startsWith("keywords/")) {
      const k = unescapePointerToken(key.slice("keywords/".length));
      if (!isValidKeyword(k)) return invalid("keywords", `Invalid keyword "${k}"`);
      if (value === true) (kw.add ??= []).push(k.toLowerCase());
      else if (value === null || value === false) (kw.remove ??= []).push(k.toLowerCase());
      else return invalid(key, "Keyword patch values must be true or null");
      kwPatch = true;
    } else if (key === "mailboxIds") {
      const m = value as Record<string, boolean> | null;
      if (m === null || typeof m !== "object" || Array.isArray(m)) {
        return invalid(key, "mailboxIds must be an object");
      }
      mb.set = Object.entries(m)
        .filter(([, v]) => v)
        .map(([k]) => ctx.resolveId(k));
      mbWhole = true;
    } else if (key.startsWith("mailboxIds/")) {
      const k = ctx.resolveId(unescapePointerToken(key.slice("mailboxIds/".length)));
      if (value === true) (mb.add ??= []).push(k);
      else if (value === null || value === false) (mb.remove ??= []).push(k);
      else return invalid(key, "Mailbox patch values must be true or null");
      mbPatch = true;
    } else {
      return invalid(key, "This property is immutable");
    }
  }
  if ((kwWhole && kwPatch) || (mbWhole && mbPatch)) {
    return { type: "invalidPatch", description: "Cannot combine a whole value and patches" };
  }
  if (kwWhole || kwPatch) op.keywords = kw;
  if (mbWhole || mbPatch) op.mailboxIds = mb;
  return op;
}
