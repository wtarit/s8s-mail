import type { BetterAuthPlugin } from "better-auth";
import { createAuthMiddleware, getSessionFromCtx, isAPIError } from "better-auth/api";
import type { OpaqueEnv } from "../opaque/common";
import { PASSKEY_COMMITTED } from "../enrollment";
import { clearPendingCookie, setPendingCookie } from "./cookies";
import { enrollmentSessionOnly, lastFactor } from "./errors";
import { peekFlowState } from "./flow";
import { requireAccountChange } from "./guard";
import { loadUserFactors } from "./load";
import type { SessionLike } from "./policy";

type Hooks = NonNullable<BetterAuthPlugin["hooks"]>;
type CtxWithResponse = { context: { responseHeaders?: Headers } };
type AuthCookies = {
  authCookies: Record<"sessionToken" | "sessionData" | "dontRememberToken", { name: string }>;
};
const at = (...paths: string[]) => {
  const set = new Set(paths);
  return (ctx: { path?: string }) => set.has(ctx.path ?? "");
};

/** Endpoints an enrollment-only session may call, besides the public sign-in endpoints. */
const ENROLLMENT_OK = new Set([
  "/get-session",
  "/sign-out",
  "/passkey/generate-register-options",
  "/passkey/verify-registration",
  "/opaque/password/start",
  "/opaque/password/finish",
  "/opaque/login/start",
  "/opaque/login/finish",
  "/pending-sign-in",
  "/sign-in/magic-link",
  "/magic-link/verify",
  "/passkey/generate-authenticate-options",
  "/passkey/verify-authentication",
]);

const cookieNames = (ctx: { context: AuthCookies }) => {
  const { sessionToken, sessionData, dontRememberToken } = ctx.context.authCookies;
  return [sessionToken.name, sessionData.name, dontRememberToken.name];
};

/** Account changes need every factor fresh (`requireAccountChange`); removing the last one is refused. */
export function beforeHooks(env: OpaqueEnv): NonNullable<Hooks["before"]> {
  return [
    {
      // An enrollment-only session reaches nothing but the first-factor setup: no OAuth
      // authorize/consent, no sessions list, no app passwords, no account change.
      matcher: (ctx) =>
        !ENROLLMENT_OK.has(ctx.path ?? "") &&
        !!(ctx.request?.headers ?? ctx.headers)
          ?.get("cookie")
          ?.includes(ctx.context.authCookies.sessionToken.name),
      handler: createAuthMiddleware(async (ctx) => {
        const signedIn = await getSessionFromCtx(ctx);
        if ((signedIn?.session as SessionLike | undefined)?.inviteId) enrollmentSessionOnly();
      }),
    },
    {
      matcher: at("/passkey/generate-register-options", "/passkey/verify-registration"),
      handler: createAuthMiddleware(async (ctx) => {
        await requireAccountChange(env, ctx, { enrollment: true });
      }),
    },
    {
      matcher: at("/api-key/create"),
      handler: createAuthMiddleware(async (ctx) => {
        await requireAccountChange(env, ctx);
      }),
    },
    {
      matcher: at("/passkey/delete-passkey"),
      handler: createAuthMiddleware(async (ctx) => {
        const { user } = await requireAccountChange(env, ctx);
        const have = await loadUserFactors(env, user.id);
        if (have.passkeys <= 1 && !have.password) lastFactor();
      }),
    },
  ];
}

export function afterHooks(env: OpaqueEnv): NonNullable<Hooks["after"]> {
  return [
    {
      // The passkey was saved inside the invite batch: answer success instead of the sentinel.
      matcher: at("/passkey/verify-registration"),
      handler: createAuthMiddleware(async (ctx) => {
        const returned = ctx.context.returned;
        if (isAPIError(returned)) {
          const body = returned.body as { code?: string; passkey?: unknown } | undefined;
          if (body?.code === PASSKEY_COMMITTED)
            return ctx.json(body.passkey as Record<string, unknown>);
          return;
        }
        // Registering proves possession of the new passkey: the session may keep changing things.
        const signedIn = await getSessionFromCtx(ctx);
        if (!signedIn) return;
        await env.DB.prepare(
          "UPDATE session SET passkey_verified_at = ? WHERE id = ? AND user_id = ?",
        )
          .bind(Date.now(), signedIn.session.id, signedIn.user.id)
          .run();
      }),
    },
    {
      // Step-up with a passkey: the plugin always creates a new session. When the request already
      // has a session of the same user, stamp THAT session instead, drop the new one before its
      // token leaves the Worker, and keep the browser's existing cookie.
      matcher: at("/passkey/verify-authentication"),
      handler: createAuthMiddleware(async (ctx) => {
        const fresh = ctx.context.newSession;
        if (!fresh) return;
        const token = await ctx.getSignedCookie(
          ctx.context.authCookies.sessionToken.name,
          ctx.context.secret,
        );
        const old = token ? await ctx.context.internalAdapter.findSession(token) : null;
        const session = old?.session as unknown as SessionLike | undefined;
        if (
          !old ||
          !session ||
          session.userId !== fresh.user.id ||
          session.impersonatedBy ||
          session.inviteId ||
          old.session.expiresAt.getTime() <= Date.now()
        )
          return;
        await env.DB.prepare(
          "UPDATE session SET passkey_verified_at = ? WHERE id = ? AND user_id = ?",
        )
          .bind(Date.now(), old.session.id, old.user.id)
          .run();
        await ctx.context.internalAdapter.deleteSession(fresh.session.token);
        const headers = (ctx as unknown as CtxWithResponse).context.responseHeaders;
        if (headers) {
          const names = cookieNames(ctx);
          const kept = headers
            .getSetCookie()
            .filter((cookie) => !names.some((name) => cookie.startsWith(`${name}=`)));
          headers.delete("set-cookie");
          for (const cookie of kept) headers.append("set-cookie", cookie);
        }
        ctx.context.newSession = null;
        return ctx.json({ session: old.session, user: old.user });
      }),
    },
    {
      // A recovery link for a 2FA user created no session: keep the first half in a pending
      // cookie and send the browser to the same callback URL, without an error.
      matcher: at("/magic-link/verify"),
      handler: createAuthMiddleware(async (ctx) => {
        const state = peekFlowState(ctx.context);
        if (!state?.recoveryIncomplete || !state.pendingToken) return;
        setPendingCookie(ctx, state.pendingToken);
        const callback = ctx.query?.callbackURL;
        throw ctx.redirect(
          new URL(callback ? decodeURIComponent(callback) : "/", ctx.context.baseURL).toString(),
        );
      }),
    },
    {
      // Once a session cookie is issued, the pending sign-in it replaced is spent.
      matcher: (ctx) =>
        !!(ctx as unknown as CtxWithResponse).context.responseHeaders
          ?.getSetCookie()
          .some((c) => c.startsWith(`${ctx.context.authCookies.sessionToken.name}=`)),
      handler: createAuthMiddleware(async (ctx) => {
        clearPendingCookie(ctx);
      }),
    },
  ];
}
