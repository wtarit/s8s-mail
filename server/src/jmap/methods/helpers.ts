import { z } from "zod";
import { MethodError } from "../errors";

/** Validates method arguments; a failure is an `invalidArguments` method error. */
export function parseArgs<S extends z.ZodType>(schema: S, args: unknown): z.infer<S> {
  const r = schema.safeParse(args);
  if (!r.success) {
    const detail = r.error.issues
      .slice(0, 3)
      .map((i) => `${i.path.join(".") || "(arguments)"}: ${i.message}`)
      .join("; ");
    throw new MethodError("invalidArguments", detail);
  }
  return r.data;
}

export const idList = z.array(z.string().min(1).max(255));

/** Common /get arguments. */
export const getArgs = z.object({
  accountId: z.string(),
  ids: idList.nullable().optional(),
  properties: z.array(z.string()).nullable().optional(),
});

/** Common /changes arguments. */
export const changesArgs = z.object({
  accountId: z.string(),
  sinceState: z.string(),
  maxChanges: z.number().int().min(1).nullable().optional(),
});

/** Picks the requested properties (always including `id`). */
export function pick<T extends Record<string, unknown>>(
  full: T,
  properties: ReadonlySet<string> | null,
): Partial<T> {
  if (!properties) return full;
  const out: Partial<T> = {};
  for (const key of Object.keys(full)) {
    if (key === "id" || properties.has(key)) (out as Record<string, unknown>)[key] = full[key];
  }
  return out;
}

/** Validates a `properties` argument against the known names. */
export function propertySet(
  properties: string[] | null | undefined,
  known: ReadonlySet<string>,
  extraAllowed?: (p: string) => boolean,
): Set<string> | null {
  if (!properties) return null;
  for (const p of properties) {
    if (!known.has(p) && !extraAllowed?.(p)) {
      throw new MethodError("invalidArguments", `Unknown property "${p}"`);
    }
  }
  return new Set(properties);
}
