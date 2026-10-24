import { expect } from "vitest";
import { BOOTSTRAP_TOKEN, cookieFrom, request, tokenFromInviteUrl, type Session } from "./index";
import { FIRST_PASSWORD, setPassword } from "./opaque";
import { VirtualPasskey } from "./passkey";

/** Opens an invite link: an enrollment-only session. The invite is NOT used up. */
export async function openInvite(inviteUrl: string): Promise<Session> {
  const res = await request<{ ok: true; userId: string }>(
    `/api/invite/${tokenFromInviteUrl(inviteUrl)}/session`,
    { method: "POST", json: {} },
  );
  if (res.status !== 200)
    throw new Error(`open invite failed: ${res.status} ${JSON.stringify(res.body)}`);
  return { cookie: cookieFrom(res.headers), userId: res.body.userId };
}

/** Opens an invite and saves a first PASSWORD: the returned session is a normal one. */
export async function acceptInvite(inviteUrl: string, password = FIRST_PASSWORD): Promise<Session> {
  const session = await openInvite(inviteUrl);
  await setPassword(session, password);
  return session;
}

/** Opens an invite and saves a first PASSKEY: the returned session is a normal one. */
export async function acceptInviteWithPasskey(inviteUrl: string) {
  const session = await openInvite(inviteUrl);
  const passkey = await VirtualPasskey.create();
  const saved = await passkey.register(session.cookie);
  expect(saved.status).toBe(200);
  return { session, passkey };
}

/** Bootstraps the first admin (admin@example.com); signs in through its invite with a password. */
export async function bootstrapAdmin(
  address = "admin@example.com",
  recoveryEmail = "admin-recovery@example.org",
): Promise<Session> {
  const res = await request<{ invite: { url: string } }>("/api/bootstrap", {
    method: "POST",
    json: { name: "Admin", primaryAddress: address, recoveryEmail },
    headers: { authorization: `Bearer ${BOOTSTRAP_TOKEN}` },
  });
  if (res.status !== 201)
    throw new Error(`bootstrap failed: ${res.status} ${JSON.stringify(res.body)}`);
  return acceptInvite(res.body.invite.url);
}

export interface TestUser {
  userId: string;
  email: string;
  session: Session;
  password?: string;
  passkey?: VirtualPasskey;
}

/**
 * Creates a user (through the admin API and its invite) with the given factors. The returned
 * session verified every factor just now. `both` is a 2FA user.
 */
export async function userWith(
  admin: Session,
  factors: "password" | "passkey" | "both",
  name = "ana",
): Promise<TestUser> {
  const email = `${name}@example.com`;
  const created = await request<{ invite: { url: string } }>("/api/admin/users", {
    method: "POST",
    cookie: admin.cookie,
    json: { name, primaryAddress: email, recoveryEmail: `${name}.recovery@example.org` },
  });
  expect(created.status).toBe(201);
  const url = created.body.invite.url;
  if (factors === "password") {
    const session = await acceptInvite(url);
    return { userId: session.userId, email, session, password: FIRST_PASSWORD };
  }
  const { session, passkey } = await acceptInviteWithPasskey(url);
  if (factors === "passkey") return { userId: session.userId, email, session, passkey };
  await setPassword(session, FIRST_PASSWORD);
  return { userId: session.userId, email, session, passkey, password: FIRST_PASSWORD };
}

/** The session's own factor timestamps (ISO strings or null), via Better Auth's get-session. */
export async function stampsOf(cookie: string) {
  const res = await request<{ session: Record<string, string | null> } | null>(
    "/api/auth/get-session",
    { cookie },
  );
  const s = res.body?.session;
  return {
    password: s?.passwordVerifiedAt ?? null,
    passkey: s?.passkeyVerifiedAt ?? null,
    recovery: s?.recoveryVerifiedAt ?? null,
    inviteId: s?.inviteId ?? null,
  };
}

/** Pretends the factors were last verified this many ms ago (everything older is stale). */
export async function ageStamps(
  cookie: string,
  agoMs: number,
  only?: ("password" | "passkey" | "recovery")[],
) {
  const { env } = await import("cloudflare:workers");
  const token = decodeURIComponent(cookie.match(/better-auth\.session_token=([^.;]+)/)![1]!);
  const at = Date.now() - agoMs;
  for (const k of only ?? (["password", "passkey", "recovery"] as const)) {
    await env.DB.prepare(
      `UPDATE session SET ${k}_verified_at = ? WHERE token = ? AND ${k}_verified_at IS NOT NULL`,
    )
      .bind(at, token)
      .run();
  }
}
