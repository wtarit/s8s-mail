import { AsyncLocalStorage } from "node:async_hooks";
import { errorFields } from "../log";

/**
 * The Better Auth instance is cached per isolate but `waitUntil` belongs to one request, so the
 * Hono middleware stores it here and background work (sending mail, ...) picks it up.
 */
const store = new AsyncLocalStorage<{ waitUntil(p: Promise<unknown>): void }>();

export function runWithWaitUntil<T>(waitUntil: (p: Promise<unknown>) => void, fn: () => T): T {
  return store.run({ waitUntil }, fn);
}

/** Runs `p` after the response is sent when a request context exists; errors are logged, never thrown. */
export function runInBackground(p: Promise<unknown>): void {
  const guarded = p.catch((err: unknown) => {
    console.error({ msg: "background task failed", ...errorFields(err) });
  });
  const ctx = store.getStore();
  if (ctx) ctx.waitUntil(guarded);
}
