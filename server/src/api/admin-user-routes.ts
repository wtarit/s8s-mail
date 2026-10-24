import { addAliasRequest, createUserRequest, updateUserRequest, type AdminUser } from "@s8s/shared";
import { and, asc, eq } from "drizzle-orm";
import { Hono } from "hono";
import { getAuth } from "../auth";
import type { AppEnv } from "../auth/types";
import { getDb, schema } from "../db";
import { ApiHttpError } from "./errors";
import {
  assertAddressAvailable,
  assertDomainServed,
  createInvite,
  createUserWithAccount,
  deleteUserCompletely,
  loadAdminUsers,
  sendInviteEmail,
  splitAddress,
} from "./users";
import { validate } from "./util";

/** Admin user and alias routes; mounted under `/admin` (guarded by `requireAdmin` there). */
export const adminUserRoutes = new Hono<AppEnv>();

// users

adminUserRoutes.get("/users", async (c) => c.json({ users: await loadAdminUsers(getDb(c.env)) }));

adminUserRoutes.post("/users", validate("json", createUserRequest), async (c) => {
  const body = c.req.valid("json");
  const { user, invite } = await createUserWithAccount(c.env, body);
  sendInviteEmail(c.env, user.recoveryEmail ?? body.recoveryEmail, user.name, invite);
  return c.json({ user, invite: { url: invite.url, expiresAt: invite.expiresAt } }, 201);
});

async function requireUser(env: Env, id: string): Promise<AdminUser> {
  const [user] = await loadAdminUsers(getDb(env), [id]);
  if (!user) throw new ApiHttpError(404, "not_found", "User not found");
  return user;
}

adminUserRoutes.patch("/users/:id", validate("json", updateUserRequest), async (c) => {
  const id = c.req.param("id");
  const body = c.req.valid("json");
  const current = await requireUser(c.env, id);
  const self = c.var.sessionUser.id === id;
  if (self && (body.disabled === true || (body.role && body.role !== "admin"))) {
    throw new ApiHttpError(400, "self_change", "You cannot disable or demote your own account");
  }
  const auth = await getAuth(c.env);
  const ctx = await auth.$context;
  const update: Record<string, unknown> = {};
  if (body.name !== undefined) update.name = body.name;
  if (body.role !== undefined) update.role = body.role;
  if (body.recoveryEmail !== undefined) update.recoveryEmail = body.recoveryEmail;
  if (body.disabled === true) {
    update.banned = true;
    update.banReason = "Disabled by an administrator";
    update.banExpires = null;
  } else if (body.disabled === false) {
    update.banned = false;
    update.banReason = null;
    update.banExpires = null;
  }
  if (Object.keys(update).length > 0) await ctx.internalAdapter.updateUser(id, update);
  if (body.disabled === true) await ctx.internalAdapter.deleteUserSessions(id);
  if (body.name !== undefined && body.name !== current.name) {
    await getDb(c.env)
      .update(schema.mailAccount)
      .set({ name: body.name })
      .where(and(eq(schema.mailAccount.ownerUserId, id), eq(schema.mailAccount.isPersonal, true)));
  }
  return c.json({ user: await requireUser(c.env, id) });
});

adminUserRoutes.post("/users/:id/invite", async (c) => {
  const user = await requireUser(c.env, c.req.param("id"));
  const invite = await createInvite(c.env, user.id);
  if (user.recoveryEmail) sendInviteEmail(c.env, user.recoveryEmail, user.name, invite);
  return c.json({ invite: { url: invite.url, expiresAt: invite.expiresAt } });
});

adminUserRoutes.delete("/users/:id", async (c) => {
  const id = c.req.param("id");
  if (id === c.var.sessionUser.id) {
    throw new ApiHttpError(400, "self_change", "You cannot delete your own account");
  }
  await requireUser(c.env, id);
  await deleteUserCompletely(c.env, id);
  return c.json({ ok: true });
});

// aliases

async function listAliases(env: Env, userId: string) {
  const rows = await getDb(env)
    .select({ address: schema.address.address, createdAt: schema.address.createdAt })
    .from(schema.address)
    .innerJoin(schema.mailAccount, eq(schema.address.accountId, schema.mailAccount.id))
    .where(and(eq(schema.mailAccount.ownerUserId, userId), eq(schema.address.kind, "alias")))
    .orderBy(asc(schema.address.createdAt), asc(schema.address.address));
  return {
    aliases: rows.map((r) => ({ address: r.address, createdAt: r.createdAt.toISOString() })),
  };
}

async function personalAccountId(env: Env, userId: string): Promise<string> {
  const row = await getDb(env)
    .select({ id: schema.mailAccount.id })
    .from(schema.mailAccount)
    .where(and(eq(schema.mailAccount.ownerUserId, userId), eq(schema.mailAccount.isPersonal, true)))
    .orderBy(asc(schema.mailAccount.createdAt))
    .get();
  if (!row) throw new ApiHttpError(404, "not_found", "User has no mail account");
  return row.id;
}

adminUserRoutes.get("/users/:id/aliases", async (c) => {
  const id = c.req.param("id");
  await requireUser(c.env, id);
  return c.json(await listAliases(c.env, id));
});

adminUserRoutes.post("/users/:id/aliases", validate("json", addAliasRequest), async (c) => {
  const id = c.req.param("id");
  const { address } = c.req.valid("json");
  await requireUser(c.env, id);
  const { localPart, domain } = splitAddress(address);
  const db = getDb(c.env);
  await assertDomainServed(db, domain);
  await assertAddressAvailable(db, address);
  const accountId = await personalAccountId(c.env, id);
  try {
    await db
      .insert(schema.address)
      .values({ address, localPart, domain, accountId, kind: "alias", createdAt: new Date() });
  } catch (err) {
    if (err instanceof Error && /UNIQUE|constraint/i.test(err.message)) {
      throw new ApiHttpError(409, "address_taken", "That address is already in use");
    }
    throw err;
  }
  return c.json(await listAliases(c.env, id), 201);
});

adminUserRoutes.delete("/users/:id/aliases/:address", async (c) => {
  const id = c.req.param("id");
  const address = decodeURIComponent(c.req.param("address")).toLowerCase();
  await requireUser(c.env, id);
  const accountId = await personalAccountId(c.env, id);
  const db = getDb(c.env);
  const isAlias = and(
    eq(schema.address.address, address),
    eq(schema.address.accountId, accountId),
    eq(schema.address.kind, "alias"),
  );
  const found = await db
    .select({ address: schema.address.address })
    .from(schema.address)
    .where(isAlias)
    .get();
  if (!found) throw new ApiHttpError(404, "not_found", "Alias not found");
  // One batch (a D1 transaction): a domain catch-all pointing at the alias is cleared with it.
  await db.batch([
    db
      .update(schema.domain)
      .set({ catchAllAddress: null })
      .where(eq(schema.domain.catchAllAddress, address)),
    db.delete(schema.address).where(isAlias),
  ]);
  return c.json(await listAliases(c.env, id));
});
