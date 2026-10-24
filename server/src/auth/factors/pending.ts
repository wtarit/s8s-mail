import { randomToken, sha256Hex } from "../../api/util";
import type { OpaqueEnv } from "../opaque/common";
import { FRESH_WINDOW_MS } from "./policy";

/** Name of the HttpOnly cookie (Better Auth adds its prefix and Secure attribute) holding the token. */
export const PENDING_COOKIE = "pending_sign_in";
export const PENDING_TTL_MS = FRESH_WINDOW_MS;

export interface PendingSignIn {
  userId: string;
  passwordVerifiedAt: number | null;
  recoveryVerifiedAt: number | null;
}

interface CookieSource {
  createAuthCookie(name: string): { name: string; attributes: Record<string, unknown> };
}

/** Raw cookie value from a request's Cookie header (the hook contexts have no `getCookie`). */
export function readCookie(headers: Headers | undefined, name: string): string | null {
  for (const part of (headers?.get("cookie") ?? "").split(";")) {
    const [key, ...rest] = part.trim().split("=");
    if (key === name) return rest.join("=") || null;
  }
  return null;
}

export const pendingCookie = (context: CookieSource) => context.createAuthCookie(PENDING_COOKIE);

/** Stores a new pending sign-in and returns the raw token for the cookie. */
export async function createPending(env: Pick<OpaqueEnv, "DB">, input: PendingSignIn) {
  const token = randomToken(32);
  const now = Date.now();
  await env.DB.batch([
    env.DB.prepare("DELETE FROM pending_sign_in WHERE expires_at <= ?").bind(now),
    env.DB.prepare(
      `INSERT INTO pending_sign_in (id, user_id, password_verified_at, recovery_verified_at, expires_at)
       VALUES (?, ?, ?, ?, ?)`,
    ).bind(
      await sha256Hex(token),
      input.userId,
      input.passwordVerifiedAt,
      input.recoveryVerifiedAt,
      now + PENDING_TTL_MS,
    ),
  ]);
  return token;
}

/** Single-use: DELETE ... RETURNING is the cross-isolate winner boundary. */
export async function consumePending(
  env: Pick<OpaqueEnv, "DB">,
  token: string | null,
  userId: string,
): Promise<PendingSignIn | null> {
  if (!token) return null;
  const row = await env.DB.prepare(
    `DELETE FROM pending_sign_in WHERE id = ? AND user_id = ? AND expires_at > ?
     RETURNING password_verified_at, recovery_verified_at`,
  )
    .bind(await sha256Hex(token), userId, Date.now())
    .first<{ password_verified_at: number | null; recovery_verified_at: number | null }>();
  return row
    ? {
        userId,
        passwordVerifiedAt: row.password_verified_at,
        recoveryVerifiedAt: row.recovery_verified_at,
      }
    : null;
}

/** Read-only view for `GET /pending-sign-in` (does not consume). */
export async function peekPending(env: Pick<OpaqueEnv, "DB">, token: string | null) {
  if (!token) return null;
  return env.DB.prepare(
    `SELECT p.user_id AS userId, u.email, p.password_verified_at AS passwordVerifiedAt,
       p.recovery_verified_at AS recoveryVerifiedAt
     FROM pending_sign_in p JOIN user u ON u.id = p.user_id
     WHERE p.id = ? AND p.expires_at > ? AND coalesce(u.banned, 0) = 0`,
  )
    .bind(await sha256Hex(token), Date.now())
    .first<PendingSignIn & { email: string }>();
}
