import { setPasswordRequest, type InviteInfoResponse, type MeResponse } from "@s8s/shared";
import { and, asc, eq, isNull } from "drizzle-orm";
import { Hono } from "hono";
import { getAuth } from "../auth";
import type { AppEnv } from "../auth/types";
import { getDb, schema } from "../db";
import { ApiHttpError } from "./errors";
import { requireSession } from "./guards";
import { maskEmail, sha256Hex, validate } from "./util";

/** Signed-in self-service (`/me`, `/account/password`) and the public invite endpoints. */
export const accountRoutes = new Hono<AppEnv>();

// ------------------------------------------------------------------ me / account

accountRoutes.get("/me", requireSession, async (c) => {
  const db = getDb(c.env);
  const u = c.var.sessionUser;
  const [row, pw, accounts, addresses] = await Promise.all([
    db
      .select({ recoveryEmail: schema.user.recoveryEmail })
      .from(schema.user)
      .where(eq(schema.user.id, u.id))
      .get(),
    db
      .select({ id: schema.account.id })
      .from(schema.account)
      .where(and(eq(schema.account.userId, u.id), eq(schema.account.providerId, "credential")))
      .get(),
    db
      .select()
      .from(schema.mailAccount)
      .where(eq(schema.mailAccount.ownerUserId, u.id))
      .orderBy(asc(schema.mailAccount.createdAt)),
    db
      .select({
        address: schema.address.address,
        kind: schema.address.kind,
        accountId: schema.address.accountId,
      })
      .from(schema.address)
      .innerJoin(schema.mailAccount, eq(schema.address.accountId, schema.mailAccount.id))
      .where(eq(schema.mailAccount.ownerUserId, u.id))
      .orderBy(asc(schema.address.createdAt)),
  ]);
  const body: MeResponse = {
    user: {
      id: u.id,
      name: u.name,
      email: u.email,
      role: u.role,
      recoveryEmailMasked: row?.recoveryEmail ? maskEmail(row.recoveryEmail) : null,
      hasPassword: !!pw,
    },
    accounts: accounts.map((a) => ({
      id: a.id,
      name: a.name,
      isPersonal: a.isPersonal,
      addresses: addresses
        .filter((x) => x.accountId === a.id)
        .toSorted((x, y) => (x.kind === y.kind ? 0 : x.kind === "primary" ? -1 : 1))
        .map((x) => ({ address: x.address, kind: x.kind })),
    })),
  };
  return c.json(body);
});

accountRoutes.post(
  "/account/password",
  requireSession,
  validate("json", setPasswordRequest),
  async (c) => {
    const { currentPassword, newPassword } = c.req.valid("json");
    const db = getDb(c.env);
    const auth = await getAuth(c.env);
    const hasPassword = await db
      .select({ id: schema.account.id })
      .from(schema.account)
      .where(
        and(
          eq(schema.account.userId, c.var.sessionUser.id),
          eq(schema.account.providerId, "credential"),
        ),
      )
      .get();
    const headers = c.req.raw.headers;
    if (!hasPassword) {
      await auth.api.setPassword({ headers, body: { newPassword } });
    } else {
      if (!currentPassword) {
        throw new ApiHttpError(400, "current_password_required", "Current password is required");
      }
      await auth.api.changePassword({
        headers,
        body: { currentPassword, newPassword, revokeOtherSessions: false },
      });
    }
    return c.json({ ok: true });
  },
);

// ------------------------------------------------------------------ invites

async function findInvite(env: Env, token: string) {
  const db = getDb(env);
  const row = await db
    .select({
      id: schema.invite.id,
      userId: schema.invite.userId,
      expiresAt: schema.invite.expiresAt,
      usedAt: schema.invite.usedAt,
      name: schema.user.name,
      email: schema.user.email,
      banned: schema.user.banned,
    })
    .from(schema.invite)
    .innerJoin(schema.user, eq(schema.invite.userId, schema.user.id))
    .where(eq(schema.invite.tokenHash, await sha256Hex(token)))
    .get();
  if (!row) throw new ApiHttpError(404, "invite_not_found", "Invite not found");
  return row;
}

accountRoutes.get("/invite/:token", async (c) => {
  const row = await findInvite(c.env, c.req.param("token"));
  const status: InviteInfoResponse["status"] = row.usedAt
    ? "used"
    : row.expiresAt.getTime() <= Date.now()
      ? "expired"
      : "valid";
  const body: InviteInfoResponse = {
    status,
    name: row.name,
    email: row.email,
    expiresAt: row.expiresAt.toISOString(),
  };
  return c.json(body);
});

accountRoutes.post("/invite/:token/accept", async (c) => {
  const row = await findInvite(c.env, c.req.param("token"));
  if (row.usedAt) throw new ApiHttpError(409, "invite_used", "This invite has already been used");
  if (row.expiresAt.getTime() <= Date.now()) {
    throw new ApiHttpError(410, "invite_expired", "This invite has expired");
  }
  if (row.banned) throw new ApiHttpError(403, "disabled", "This account is disabled");
  const db = getDb(c.env);
  // Atomically consume the invite: only one concurrent accept can win.
  const claimed = await db
    .update(schema.invite)
    .set({ usedAt: new Date() })
    .where(and(eq(schema.invite.id, row.id), isNull(schema.invite.usedAt)))
    .returning({ id: schema.invite.id });
  if (claimed.length === 0) {
    throw new ApiHttpError(409, "invite_used", "This invite has already been used");
  }
  const auth = await getAuth(c.env);
  let created;
  try {
    created = await auth.api.createInviteSession({
      headers: c.req.raw.headers,
      body: { userId: row.userId },
      returnHeaders: true,
    });
  } catch (err) {
    // do not burn the invite when no session could be started
    await db.update(schema.invite).set({ usedAt: null }).where(eq(schema.invite.id, row.id));
    throw err;
  }
  const { headers, response } = created;
  const res = c.json({ ok: true as const, userId: response.userId });
  for (const cookie of headers.getSetCookie()) res.headers.append("set-cookie", cookie);
  return res;
});
