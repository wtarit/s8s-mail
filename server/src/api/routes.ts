import {
  addAliasRequest,
  addDomainRequest,
  createOAuthClientRequest,
  createUserRequest,
  setPasswordRequest,
  updateUserRequest,
  type AdminUser,
  type InviteInfoResponse,
  type MeResponse,
} from "@s8s/shared";
import { and, asc, count, eq, isNull } from "drizzle-orm";
import { Hono } from "hono";
import { z } from "zod";
import { getAuth } from "../auth";
import type { AppEnv } from "../auth/types";
import { getDb, schema } from "../db";
import { ApiHttpError, respondError } from "./errors";
import { checkOrigin, requireAdmin, requireSession } from "./guards";
import {
  createOAuthClient,
  deleteOAuthClient,
  ensureBulwarkClient,
  listOAuthClients,
} from "./oauth-clients";
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
import { maskEmail, safeEqual, sha256Hex, validate } from "./util";

export const api = new Hono<AppEnv>();

api.onError((err, c) => respondError(c, err));
api.use("*", checkOrigin);

// ------------------------------------------------------------------ bootstrap

const bootstrapRequest = z.object({
  name: z.string().trim().min(1).max(100),
  primaryAddress: createUserRequest.shape.primaryAddress,
  recoveryEmail: createUserRequest.shape.recoveryEmail,
});

/** Creates the first admin. Needs `Authorization: Bearer <BOOTSTRAP_TOKEN>`; only with zero users. */
api.post("/bootstrap", validate("json", bootstrapRequest), async (c) => {
  const secret = c.env.BOOTSTRAP_TOKEN;
  if (!secret) throw new ApiHttpError(404, "not_found", "Not found");
  const m = /^Bearer (.+)$/i.exec(c.req.header("authorization") ?? "");
  if (!m?.[1] || !(await safeEqual(m[1], secret))) {
    throw new ApiHttpError(401, "unauthorized", "Invalid bootstrap token");
  }
  const db = getDb(c.env);
  const existing = await db.select({ n: count() }).from(schema.user).get();
  if ((existing?.n ?? 0) > 0) {
    throw new ApiHttpError(409, "already_bootstrapped", "This deployment already has users");
  }
  const body = c.req.valid("json");
  const { invite } = await createUserWithAccount(
    c.env,
    { ...body, role: "admin" },
    { createDomain: true },
  );
  await ensureBulwarkClient(c.env);
  sendInviteEmail(c.env, body.recoveryEmail, body.name, invite);
  return c.json({ invite: { url: invite.url, expiresAt: invite.expiresAt } }, 201);
});

// ------------------------------------------------------------------ me / account

api.get("/me", requireSession, async (c) => {
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

api.post("/account/password", requireSession, validate("json", setPasswordRequest), async (c) => {
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
});

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

api.get("/invite/:token", async (c) => {
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

api.post("/invite/:token/accept", async (c) => {
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

// ------------------------------------------------------------------ admin

const admin = new Hono<AppEnv>();
admin.use("*", requireAdmin);

// users

admin.get("/users", async (c) => c.json({ users: await loadAdminUsers(getDb(c.env)) }));

admin.post("/users", validate("json", createUserRequest), async (c) => {
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

admin.patch("/users/:id", validate("json", updateUserRequest), async (c) => {
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

admin.post("/users/:id/invite", async (c) => {
  const user = await requireUser(c.env, c.req.param("id"));
  const invite = await createInvite(c.env, user.id);
  if (user.recoveryEmail) sendInviteEmail(c.env, user.recoveryEmail, user.name, invite);
  return c.json({ invite: { url: invite.url, expiresAt: invite.expiresAt } });
});

admin.delete("/users/:id", async (c) => {
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

admin.get("/users/:id/aliases", async (c) => {
  const id = c.req.param("id");
  await requireUser(c.env, id);
  return c.json(await listAliases(c.env, id));
});

admin.post("/users/:id/aliases", validate("json", addAliasRequest), async (c) => {
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

admin.delete("/users/:id/aliases/:address", async (c) => {
  const id = c.req.param("id");
  const address = decodeURIComponent(c.req.param("address")).toLowerCase();
  await requireUser(c.env, id);
  const accountId = await personalAccountId(c.env, id);
  const deleted = await getDb(c.env)
    .delete(schema.address)
    .where(
      and(
        eq(schema.address.address, address),
        eq(schema.address.accountId, accountId),
        eq(schema.address.kind, "alias"),
      ),
    )
    .returning({ address: schema.address.address });
  if (deleted.length === 0) throw new ApiHttpError(404, "not_found", "Alias not found");
  return c.json(await listAliases(c.env, id));
});

// domains

async function listDomains(env: Env) {
  const db = getDb(env);
  const [domains, counts] = await Promise.all([
    db.select().from(schema.domain).orderBy(asc(schema.domain.name)),
    db
      .select({ domain: schema.address.domain, n: count() })
      .from(schema.address)
      .groupBy(schema.address.domain),
  ]);
  const byDomain = new Map(counts.map((r) => [r.domain, r.n]));
  return {
    domains: domains.map((d) => ({
      name: d.name,
      addressCount: byDomain.get(d.name) ?? 0,
      createdAt: d.createdAt.toISOString(),
    })),
  };
}

admin.get("/domains", async (c) => c.json(await listDomains(c.env)));

admin.post("/domains", validate("json", addDomainRequest), async (c) => {
  const { name } = c.req.valid("json");
  const db = getDb(c.env);
  const inserted = await db
    .insert(schema.domain)
    .values({ name, createdAt: new Date() })
    .onConflictDoNothing()
    .returning({ name: schema.domain.name });
  if (inserted.length === 0) throw new ApiHttpError(409, "domain_exists", "Domain already exists");
  return c.json(await listDomains(c.env), 201);
});

admin.delete("/domains/:name", async (c) => {
  const name = c.req.param("name").toLowerCase();
  const db = getDb(c.env);
  const exists = await db
    .select({ name: schema.domain.name })
    .from(schema.domain)
    .where(eq(schema.domain.name, name))
    .get();
  if (!exists) throw new ApiHttpError(404, "not_found", "Domain not found");
  const used = await db
    .select({ n: count() })
    .from(schema.address)
    .where(eq(schema.address.domain, name))
    .get();
  if ((used?.n ?? 0) > 0) {
    throw new ApiHttpError(409, "domain_in_use", "Domain still has addresses");
  }
  await db.delete(schema.domain).where(eq(schema.domain.name, name));
  return c.json(await listDomains(c.env));
});

// oauth clients ("Sign-in apps")

admin.get("/oauth-clients", async (c) => c.json({ clients: await listOAuthClients(c.env) }));

admin.post("/oauth-clients", validate("json", createOAuthClientRequest), async (c) => {
  const result = await createOAuthClient(c.env, c.req.raw.headers, c.req.valid("json"));
  return c.json(result, 201);
});

/** Idempotently (re)creates the first-party webmail client from BULWARK_CLIENT_ID / WEBMAIL_ORIGIN. */
admin.post("/oauth-clients/ensure-defaults", async (c) =>
  c.json({ client: await ensureBulwarkClient(c.env) }),
);

admin.delete("/oauth-clients/:clientId", async (c) => {
  await deleteOAuthClient(c.env, c.req.param("clientId"));
  return c.json({ ok: true });
});

api.route("/admin", admin);
