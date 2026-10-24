import { conflict, type OpaqueEnv } from "../opaque/common";
import { inviteUnavailable } from "../factors/errors";
import { expiredSessionTokens, revocationStatements, type Guard } from "../factors/revocation";

export interface PasskeyRow {
  id: string;
  name: string | null;
  publicKey: string;
  credentialID: string;
  counter: number;
  deviceType: string;
  backedUp: boolean;
  transports: string;
  createdAt: number;
  aaguid: string | null;
}

export type FirstFactor =
  | { kind: "password"; registrationRecord: string }
  | { kind: "passkey"; passkey: PasskeyRow };

/**
 * Saving the FIRST factor from an invite. In ONE D1 batch: claim the invite (only one concurrent
 * attempt can win; it must still be unused and unexpired), save the factor, run the full reset
 * (old password, passkeys, app passwords, OAuth tokens, pending handshakes, every other
 * session) and turn the enrollment session into a normal one with that factor verified now.
 *
 * Every statement after the claim is conditional on `claim_id` being OURS, so a loser changes
 * nothing. Returns the tokens of the expired sessions for Better Auth to delete afterwards.
 */
export async function commitFirstFactor(
  env: OpaqueEnv,
  input: { userId: string; sessionId: string; inviteId: string } & FirstFactor,
): Promise<string[]> {
  const { userId, sessionId, inviteId } = input;
  const now = Date.now();
  const claimId = crypto.randomUUID();
  const guard: Guard = {
    sql: "EXISTS (SELECT 1 FROM invite WHERE id = ? AND claim_id = ?)",
    params: [inviteId, claimId],
  };
  const when = (sql: string, ...params: unknown[]) =>
    env.DB.prepare(`${sql} AND ${guard.sql}`).bind(...params, ...guard.params);

  const claim = env.DB.prepare(
    `UPDATE invite SET used_at = ?, claim_id = ?
     WHERE id = ? AND user_id = ? AND used_at IS NULL AND expires_at > ?
     AND EXISTS (SELECT 1 FROM session s JOIN user u ON u.id = s.user_id
       WHERE s.id = ? AND s.user_id = ? AND s.invite_id = ? AND s.expires_at > ?
       AND s.impersonated_by IS NULL AND coalesce(u.banned, 0) = 0)`,
  ).bind(now, claimId, inviteId, userId, now, sessionId, userId, inviteId, now);

  const save =
    input.kind === "password"
      ? [
          when("DELETE FROM passkey WHERE user_id = ?", userId),
          env.DB.prepare(
            `INSERT INTO opaque_credential (user_id, registration_record) SELECT ?, ? WHERE ${guard.sql}
             ON CONFLICT(user_id) DO UPDATE SET registration_record = excluded.registration_record`,
          ).bind(userId, input.registrationRecord, ...guard.params),
          when(
            `UPDATE session SET invite_id = NULL, password_verified_at = ?, passkey_verified_at = NULL,
             recovery_verified_at = NULL WHERE id = ?`,
            now,
            sessionId,
          ),
        ]
      : [
          when("DELETE FROM passkey WHERE user_id = ?", userId),
          when("DELETE FROM opaque_credential WHERE user_id = ?", userId),
          env.DB.prepare(
            `INSERT INTO passkey (id, name, public_key, user_id, credential_id, counter, device_type,
               backed_up, transports, created_at, aaguid)
             SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ? WHERE ${guard.sql}`,
          ).bind(
            input.passkey.id,
            input.passkey.name,
            input.passkey.publicKey,
            userId,
            input.passkey.credentialID,
            input.passkey.counter,
            input.passkey.deviceType,
            input.passkey.backedUp ? 1 : 0,
            input.passkey.transports,
            input.passkey.createdAt,
            input.passkey.aaguid,
            ...guard.params,
          ),
          when(
            `UPDATE session SET invite_id = NULL, password_verified_at = NULL, passkey_verified_at = ?,
             recovery_verified_at = NULL WHERE id = ?`,
            now,
            sessionId,
          ),
        ];

  const scope = { userId, keepSessionId: sessionId, now, guard };
  const result = await env.DB.batch<{ token: string }>([
    claim,
    ...save,
    ...revocationStatements(env, scope),
    expiredSessionTokens(env, scope),
  ]);
  if (result[0]?.meta.changes !== 1) {
    // Lost the race, or the invite ended in between: say which.
    const row = await env.DB.prepare("SELECT used_at, expires_at FROM invite WHERE id = ?")
      .bind(inviteId)
      .first<{ used_at: number | null; expires_at: number }>();
    if (!row) inviteUnavailable("missing");
    if (row.used_at) inviteUnavailable("used");
    if (row.expires_at <= Date.now()) inviteUnavailable("expired");
    conflict();
  }
  return result.at(-1)!.results.map((r) => r.token);
}
