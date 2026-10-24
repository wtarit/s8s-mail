import { pendingCookie, PENDING_TTL_MS, readCookie } from "./pending";

interface CookieCtx {
  context: {
    createAuthCookie(name: string): { name: string; attributes: Record<string, unknown> };
  };
  headers?: Headers;
  request?: Request;
  setCookie(name: string, value: string, options?: Record<string, unknown>): unknown;
}

/** The pending-sign-in token this browser sent, if any. */
export function pendingTokenFrom(ctx: Pick<CookieCtx, "context" | "headers" | "request">) {
  return readCookie(ctx.request?.headers ?? ctx.headers, pendingCookie(ctx.context).name);
}

export function setPendingCookie(ctx: CookieCtx, token: string) {
  const cookie = pendingCookie(ctx.context);
  ctx.setCookie(cookie.name, token, {
    ...cookie.attributes,
    httpOnly: true,
    maxAge: PENDING_TTL_MS / 1000,
  });
}

export function clearPendingCookie(ctx: CookieCtx) {
  if (!pendingTokenFrom(ctx)) return;
  const cookie = pendingCookie(ctx.context);
  ctx.setCookie(cookie.name, "", { ...cookie.attributes, httpOnly: true, maxAge: 0 });
}
