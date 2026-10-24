import type { BetterAuthPlugin } from "better-auth";
import { createAuthEndpoint } from "better-auth/api";
import type { OpaqueEnv } from "../opaque/common";
import { pendingTokenFrom } from "./cookies";
import { afterHooks, beforeHooks } from "./hooks";
import { peekPending } from "./pending";
import { factorList } from "./policy";
import { sessionCreateHook } from "./session-hooks";
import { loadUserFactors } from "./load";

/**
 * Per-session factor tracking and the account-change policy (CLAUDE.md "Account security
 * model"). Sessions carry `passwordVerifiedAt` / `passkeyVerifiedAt` / `recoveryVerifiedAt`
 * (see `session.additionalFields` in auth.ts); `requireAccountChange` is the single gate.
 */
export const accountFactors = (env: OpaqueEnv) =>
  ({
    id: "s8s-factors",
    endpoints: {
      /** The half-finished sign-in/recovery of a 2FA user, so the SPA can ask for the rest. */
      pendingSignIn: createAuthEndpoint("/pending-sign-in", { method: "GET" }, async (ctx) => {
        ctx.setHeader("Cache-Control", "no-store");
        const row = await peekPending(env, pendingTokenFrom(ctx));
        if (!row) return ctx.json({ pending: null });
        const via = row.recoveryVerifiedAt ? ("recovery" as const) : ("password" as const);
        const factors =
          via === "password"
            ? ["passkey" as const]
            : factorList(await loadUserFactors(env, row.userId)).toSorted();
        return ctx.json({ pending: factors.length ? { via, email: row.email, factors } : null });
      }),
    },
    hooks: { before: beforeHooks(env), after: afterHooks(env) },
    init: () => ({
      options: { databaseHooks: { session: { create: { before: sessionCreateHook(env) } } } },
    }),
  }) satisfies BetterAuthPlugin;
