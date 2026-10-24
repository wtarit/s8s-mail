import type { UserFactors } from "./policy";

/** What the user has: a password record and/or passkeys. One D1 round trip. */
export async function loadUserFactors(env: { DB: D1Database }, userId: string) {
  const row = await env.DB.prepare(
    `SELECT EXISTS (SELECT 1 FROM opaque_credential WHERE user_id = ?1) AS password,
      (SELECT count(*) FROM passkey WHERE user_id = ?1) AS passkeys`,
  )
    .bind(userId)
    .first<{ password: number; passkeys: number }>();
  return { password: !!row?.password, passkeys: row?.passkeys ?? 0 } satisfies UserFactors;
}
