import {
  activeSessionGuard,
  expiredSessionTokens,
  revocationStatements,
} from "../factors/revocation";
import { conflict, type OpaqueEnv } from "./common";

/**
 * Password set/change: the record is upserted and everything the old password protected is
 * revoked in ONE D1 batch (see `revocationStatements`). The calling session stays and gets a
 * fresh password verification. Returns the tokens of the sessions to delete afterwards.
 */
export async function replacePassword(
  env: OpaqueEnv,
  input: { userId: string; sessionId: string; registrationRecord: string },
) {
  const now = Date.now();
  const { userId, sessionId } = input;
  const guard = activeSessionGuard(sessionId, userId, now);
  const scope = { userId, keepSessionId: sessionId, now, guard };
  const result = await env.DB.batch<{ token: string }>([
    env.DB.prepare(
      `INSERT INTO opaque_credential (user_id, registration_record) SELECT ?, ? WHERE ${guard.sql}
       ON CONFLICT(user_id) DO UPDATE SET registration_record = excluded.registration_record`,
    ).bind(userId, input.registrationRecord, ...guard.params),
    ...revocationStatements(env, scope),
    env.DB.prepare(
      `UPDATE session SET password_verified_at = ? WHERE id = ? AND ${guard.sql}`,
    ).bind(now, sessionId, ...guard.params),
    expiredSessionTokens(env, scope),
  ]);
  if (result[0]?.meta.changes !== 1) conflict();
  return result.at(-1)!.results.map((row) => row.token);
}
