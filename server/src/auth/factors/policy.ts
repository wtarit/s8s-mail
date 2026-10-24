// Pure rules of the account security model (docs/account-security.md). No I/O.

/** How long a factor verification counts for account changes. A time window, not a one-time grant. */
export const FRESH_WINDOW_MS = 5 * 60 * 1000;

export type Factor = "password" | "passkey";

/** The factors a user HAS: a password (opaque_credential row) and/or passkeys. */
export interface UserFactors {
  password: boolean;
  passkeys: number;
}

/** When this session (or pending sign-in) verified each thing, epoch ms. */
export interface Stamps {
  password?: number | null;
  passkey?: number | null;
  recovery?: number | null;
}

/** The session columns the account security model adds (all epoch-ms capable, all nullable). */
export interface SessionLike {
  id: string;
  userId: string;
  impersonatedBy?: string | null;
  /** Set only on an enrollment-only session opened from an invite link. */
  inviteId?: string | null;
  passwordVerifiedAt?: Date | number | null;
  passkeyVerifiedAt?: Date | number | null;
  recoveryVerifiedAt?: Date | number | null;
}

const ms = (value: Date | number | null | undefined) =>
  value instanceof Date ? value.getTime() : (value ?? null);

export const sessionStamps = (s: SessionLike): Stamps => ({
  password: ms(s.passwordVerifiedAt),
  passkey: ms(s.passkeyVerifiedAt),
  recovery: ms(s.recoveryVerifiedAt),
});

export const hasFactor = (f: UserFactors, factor: Factor) =>
  factor === "password" ? f.password : f.passkeys > 0;

export const factorList = (f: UserFactors): Factor[] =>
  (["password", "passkey"] as const).filter((x) => hasFactor(f, x));

export const isFresh = (at: number | null | undefined, now: number): at is number =>
  typeof at === "number" && at <= now && now - at <= FRESH_WINDOW_MS;

export interface AccountChangeStatus {
  allowed: boolean;
  /** Factors still to verify (empty when allowed). */
  stale: Factor[];
  /** True when verifying any ONE of `stale` is enough (the recovery link covers the other). */
  oneOf: boolean;
  recoveryFresh: boolean;
  /** A password change must prove the current password (not for a first password or recovery). */
  currentPasswordRequired: boolean;
}

/**
 * Account changes need EVERY factor the user has, verified in this session within the window.
 * A fresh recovery link substitutes for exactly one missing factor. `proven` lists factors the
 * current request proves itself (the current-password proof of a password change).
 */
export function accountChangeStatus(
  have: UserFactors,
  stamps: Stamps,
  now: number,
  proven: Factor[] = [],
): AccountChangeStatus {
  const recoveryFresh = isFresh(stamps.recovery, now);
  const stale = factorList(have).filter((x) => !proven.includes(x) && !isFresh(stamps[x], now));
  const allowed = stale.length <= (recoveryFresh ? 1 : 0);
  return {
    allowed,
    stale: allowed ? [] : stale,
    oneOf: !allowed && recoveryFresh && stale.length === 2,
    recoveryFresh,
    currentPasswordRequired: have.password && !recoveryFresh,
  };
}

/**
 * Does this set of verified things sign the user in?
 * - a passkey alone does;
 * - a password does unless the user also has a passkey (2FA), unless the recovery link stands in
 *   for that passkey;
 * - the recovery link alone does only when it stands in for the user's single factor.
 */
export function signInSatisfied(
  have: UserFactors,
  verified: { password?: boolean; passkey?: boolean; recovery?: boolean },
): boolean {
  if (verified.passkey && have.passkeys > 0) return true;
  if (verified.password && have.password) return have.passkeys === 0 || !!verified.recovery;
  if (verified.recovery) return factorList(have).length === 1;
  return false;
}
