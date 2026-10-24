import type { OpaqueEnv } from "../opaque/common";

/** A SQL condition (and its bound values) every statement of an account-change batch repeats. */
export interface Guard {
  sql: string;
  params: unknown[];
}

/** This session still exists, belongs to the user, is a normal session and the user is not banned. */
export const activeSessionGuard = (sessionId: string, userId: string, now: number): Guard => ({
  sql: `EXISTS (SELECT 1 FROM session s JOIN user u ON u.id = s.user_id
    WHERE s.id = ? AND s.user_id = ? AND s.expires_at > ? AND s.impersonated_by IS NULL
    AND s.invite_id IS NULL AND coalesce(u.banned, 0) = 0)`,
  params: [sessionId, userId, now],
});

/**
 * The statements shared by every credential change: pending login handshakes and pending
 * sign-ins die, OAuth tokens are revoked, every other session is expired (the caller deletes
 * them through Better Auth afterwards so OIDC logout hooks run) and ALL app passwords go.
 * Each is conditional on `guard`, so a batch that lost its race changes nothing.
 */
export function revocationStatements(
  env: Pick<OpaqueEnv, "DB">,
  o: { userId: string; keepSessionId: string; now: number; guard: Guard },
): D1PreparedStatement[] {
  const { userId, keepSessionId, now, guard } = o;
  const run = (sql: string, ...params: unknown[]) =>
    env.DB.prepare(`${sql} AND ${guard.sql}`).bind(...params, ...guard.params);
  return [
    run("DELETE FROM opaque_challenge WHERE user_id = ?", userId),
    run("DELETE FROM pending_sign_in WHERE user_id = ?", userId),
    run("UPDATE oauth_refresh_token SET revoked = ? WHERE user_id = ?", now, userId),
    run("UPDATE oauth_access_token SET revoked = ? WHERE user_id = ?", now, userId),
    run(
      "UPDATE session SET expires_at = ? WHERE user_id = ? AND id <> ?",
      now,
      userId,
      keepSessionId,
    ),
    run("DELETE FROM apikey WHERE reference_id = ?", userId),
  ];
}

/** Tokens of the sessions the batch expired, for Better Auth's `deleteSessions`. */
export const expiredSessionTokens = (
  env: Pick<OpaqueEnv, "DB">,
  o: { userId: string; keepSessionId: string; now: number; guard: Guard },
) =>
  env.DB.prepare(
    `SELECT token FROM session WHERE user_id = ? AND id <> ? AND expires_at <= ? AND ${o.guard.sql}`,
  ).bind(o.userId, o.keepSessionId, o.now, ...o.guard.params);
