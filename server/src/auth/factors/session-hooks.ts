import type { BetterAuthOptions } from "better-auth";
import type { OpaqueEnv } from "../opaque/common";
import { pendingTokenFrom } from "./cookies";
import { flowState } from "./flow";
import { resolveSignIn } from "./sign-in";

type SessionHook = NonNullable<
  NonNullable<NonNullable<BetterAuthOptions["databaseHooks"]>["session"]>["create"]
>["before"];

/**
 * Sessions created by Better Auth plugins we do not control get their factor stamps here, and
 * the recovery link of a 2FA user gets no session at all. Any other creator (admin impersonation,
 * future plugins) yields a session with NO verified factor, so it can never change the account.
 */
export function sessionCreateHook(env: OpaqueEnv): NonNullable<SessionHook> {
  return async (session, ctx) => {
    if (!ctx) return;
    const userId = session.userId as string;
    if (ctx.path === "/passkey/verify-authentication") {
      // A passkey alone signs in; a pending password/recovery proof of this browser is merged in.
      const outcome = await resolveSignIn(
        env,
        userId,
        { passkey: Date.now() },
        pendingTokenFrom(ctx),
      );
      if (outcome.done) return { data: outcome.stamps };
    }
    if (ctx.path === "/magic-link/verify") {
      const outcome = await resolveSignIn(
        env,
        userId,
        { recovery: Date.now() },
        pendingTokenFrom(ctx),
      );
      if (outcome.done) return { data: outcome.stamps };
      // 2FA user: the link is only the first half. No session; the after hook sets the pending cookie.
      Object.assign(flowState(ctx.context), {
        pendingToken: outcome.pendingToken,
        recoveryIncomplete: true,
      });
      return false;
    }
  };
}
