import type { InviteInfoResponse } from "#shared";
import { eq } from "drizzle-orm";
import { Hono } from "hono";
import { getAuth } from "../auth";
import type { AppEnv } from "../auth/types";
import { getDb, schema } from "../db";
import { ApiHttpError } from "./errors";
import { sha256Hex } from "./util";

/**
 * Public invite endpoints. Opening a link NEVER uses the invite up: it only starts an
 * enrollment-only session. The invite is spent when the first factor is saved
 * (`auth/enrollment/commit.ts`), so the user can leave and come back until it expires.
 */
export const inviteRoutes = new Hono<AppEnv>();

async function findInvite(env: Env, token: string) {
  const row = await getDb(env)
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

inviteRoutes.get("/invite/:token", async (c) => {
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

inviteRoutes.post("/invite/:token/session", async (c) => {
  const row = await findInvite(c.env, c.req.param("token"));
  if (row.usedAt) throw new ApiHttpError(409, "invite_used", "This invite has already been used");
  if (row.expiresAt.getTime() <= Date.now()) {
    throw new ApiHttpError(410, "invite_expired", "This invite has expired");
  }
  if (row.banned) throw new ApiHttpError(403, "disabled", "This account is disabled");
  const auth = await getAuth(c.env);
  const { headers, response } = await auth.api.createInviteSession({
    headers: c.req.raw.headers,
    body: { userId: row.userId, inviteId: row.id, expiresAt: row.expiresAt.getTime() },
    returnHeaders: true,
  });
  const res = c.json({ ok: true as const, userId: response.userId });
  for (const cookie of headers.getSetCookie()) res.headers.append("set-cookie", cookie);
  return res;
});
