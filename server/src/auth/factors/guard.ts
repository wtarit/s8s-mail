import { APIError, getSessionFromCtx } from "better-auth/api";
import type { OpaqueEnv } from "../opaque/common";
import {
  accountChangeNotAllowed,
  enrollmentSessionOnly,
  inviteUnavailable,
  reauthRequired,
} from "./errors";
import {
  accountChangeStatus,
  sessionStamps,
  type AccountChangeStatus,
  type Factor,
  type SessionLike,
  type UserFactors,
} from "./policy";
import { loadUserFactors } from "./load";

type Ctx = Parameters<typeof getSessionFromCtx>[0];

export interface AccountChange {
  session: SessionLike & { token: string };
  user: { id: string; email: string };
  /** The session is an enrollment-only invite session (the first factor is being saved). */
  enrollment: boolean;
  factors: UserFactors;
  status: AccountChangeStatus;
}

/**
 * THE gate for account changes (set/change password, add/remove a passkey, create an app
 * password). Allowed when the session is not impersonated and every factor the user has was
 * verified in this session within the last 5 minutes; a fresh recovery link covers exactly one
 * missing factor. Otherwise throws `REAUTHENTICATION_REQUIRED` naming the stale factors.
 *
 * An enrollment-only session (opened from an invite) passes only when `enrollment` is set, i.e.
 * for saving the FIRST factor, and only while its invite is still open. Every other change
 * refuses it. `proven` lists factors this very request proves (the current-password proof).
 */
export async function requireAccountChange(
  env: OpaqueEnv,
  ctx: Ctx,
  opts: { enrollment?: boolean; proven?: Factor[] } = {},
): Promise<AccountChange> {
  const signedIn = await getSessionFromCtx(ctx);
  if (!signedIn) {
    throw APIError.from("UNAUTHORIZED", { code: "UNAUTHORIZED", message: "Sign in required" });
  }
  const session = signedIn.session as unknown as AccountChange["session"];
  const user = signedIn.user as AccountChange["user"] & { banned?: boolean | null };
  if (user.banned || session.impersonatedBy) accountChangeNotAllowed();

  if (session.inviteId) {
    if (!opts.enrollment) enrollmentSessionOnly();
    await requireOpenInvite(env, session.inviteId, user.id);
    const none = { password: false, passkeys: 0 };
    const status = accountChangeStatus(none, {}, Date.now());
    return { session, user, enrollment: true, factors: none, status };
  }

  const factors = await loadUserFactors(env, user.id);
  const status = accountChangeStatus(factors, sessionStamps(session), Date.now(), opts.proven);
  if (!status.allowed) reauthRequired(status);
  return { session, user, enrollment: false, factors, status };
}

/** The invite an enrollment session was opened from; throws a clear error when it is spent. */
export async function requireOpenInvite(
  env: Pick<OpaqueEnv, "DB">,
  inviteId: string,
  userId: string,
) {
  const row = await env.DB.prepare(
    "SELECT expires_at, used_at FROM invite WHERE id = ? AND user_id = ?",
  )
    .bind(inviteId, userId)
    .first<{ expires_at: number; used_at: number | null }>();
  if (!row) inviteUnavailable("missing");
  if (row.used_at) inviteUnavailable("used");
  if (row.expires_at <= Date.now()) inviteUnavailable("expired");
}
