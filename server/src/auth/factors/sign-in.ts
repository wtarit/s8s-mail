import type { OpaqueEnv } from "../opaque/common";
import { consumePending, createPending } from "./pending";
import { signInSatisfied } from "./policy";
import { loadUserFactors } from "./load";

/** The session columns a completed sign-in starts with. */
export interface SignInStamps {
  passwordVerifiedAt?: Date;
  passkeyVerifiedAt?: Date;
  recoveryVerifiedAt?: Date;
}

export type SignInOutcome =
  | { done: true; stamps: SignInStamps }
  /** `pendingToken` is null when there is nothing to complete (a user with no factors). */
  | { done: false; pendingToken: string | null };

const at = (ms: number | null | undefined) => (ms == null ? undefined : new Date(ms));

/**
 * A first factor was just verified (`event`). Combine it with the browser's pending sign-in (if
 * any, consumed here) and decide: a session now, or a new pending sign-in for the second step.
 * A passkey alone signs in; a password signs in only for a user without a passkey (or with the
 * recovery link standing in for it); the recovery link alone signs in only a single-factor user.
 */
export async function resolveSignIn(
  env: Pick<OpaqueEnv, "DB">,
  userId: string,
  event: { password?: number; passkey?: number; recovery?: number },
  pendingToken: string | null,
): Promise<SignInOutcome> {
  const [have, pending] = await Promise.all([
    loadUserFactors(env, userId),
    consumePending(env, pendingToken, userId),
  ]);
  const password = event.password ?? pending?.passwordVerifiedAt ?? undefined;
  const recovery = event.recovery ?? pending?.recoveryVerifiedAt ?? undefined;
  const passkey = event.passkey;
  if (signInSatisfied(have, { password: !!password, passkey: !!passkey, recovery: !!recovery })) {
    return {
      done: true,
      stamps: {
        passwordVerifiedAt: at(password),
        passkeyVerifiedAt: at(passkey),
        recoveryVerifiedAt: at(recovery),
      },
    };
  }
  if (!have.password && have.passkeys === 0) return { done: false, pendingToken: null };
  const token = await createPending(env, {
    userId,
    passwordVerifiedAt: password ?? null,
    recoveryVerifiedAt: recovery ?? null,
  });
  return { done: false, pendingToken: token };
}
