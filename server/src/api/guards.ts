import { createMiddleware } from "hono/factory";
import { getAuth } from "../auth";
import { publicOrigin } from "../auth/config";
import type { AppEnv, SessionUser } from "../auth/types";
import { ApiHttpError } from "./errors";

/** Resolves the Better Auth session cookie into `c.var.sessionUser`; 401 if absent. */
export const requireSession = createMiddleware<AppEnv>(async (c, next) => {
  const auth = await getAuth(c.env);
  const result = await auth.api.getSession({ headers: c.req.raw.headers });
  if (!result) throw new ApiHttpError(401, "unauthenticated", "Sign in required");
  const u = result.user as typeof result.user & { role?: string | null; banned?: boolean | null };
  if (u.banned) throw new ApiHttpError(403, "disabled", "This account is disabled");
  const sessionUser: SessionUser = {
    id: u.id,
    name: u.name,
    email: u.email,
    role: u.role === "admin" ? "admin" : "user",
  };
  c.set("sessionUser", sessionUser);
  await next();
});

/** Session + role === "admin"; 403 otherwise. */
export const requireAdmin = createMiddleware<AppEnv>(async (c, next) => {
  await requireSession(c, async () => {});
  if (c.var.sessionUser.role !== "admin") {
    throw new ApiHttpError(403, "forbidden", "Administrator access required");
  }
  await next();
});

/**
 * CSRF defence for cookie-authenticated mutations. Session cookies are SameSite=Lax and the body
 * must be JSON, but we also reject any mutating request whose Origin is not one of ours.
 */
export const checkOrigin = createMiddleware<AppEnv>(async (c, next) => {
  const method = c.req.method;
  if (method !== "GET" && method !== "HEAD" && method !== "OPTIONS") {
    const origin = c.req.header("origin");
    if (origin) {
      const spa = (c.env as { SPA_ORIGIN?: string }).SPA_ORIGIN;
      if (origin !== publicOrigin(c.env) && origin !== spa) {
        throw new ApiHttpError(403, "bad_origin", "Cross-origin request blocked");
      }
    }
  }
  await next();
});
