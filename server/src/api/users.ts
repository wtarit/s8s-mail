import type { AdminUser, Invite, Role } from "#shared";
import { and, asc, count, eq, gt, inArray, isNull, max, sql } from "drizzle-orm";
import { getAuth } from "../auth";
import { runInBackground } from "../auth/request-context";
import { sendSystemMailLazy } from "../auth/system-mail";
import { errorFields } from "../log";
import { getDb, schema, type Db } from "../db";
import { ApiHttpError } from "./errors";
import { randomHex, randomToken, sha256Hex } from "./util";

const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export function newAccountId(): string {
  return `a${randomHex(10)}`;
}

/** Splits and validates an address we can host: lowercased, no +tag in the stored form. */
export function splitAddress(address: string): { localPart: string; domain: string } {
  const at = address.lastIndexOf("@");
  const localPart = address.slice(0, at);
  const domain = address.slice(at + 1);
  if (at < 1 || !domain) throw new ApiHttpError(400, "invalid_address", "Invalid address");
  if (localPart.includes("+")) {
    throw new ApiHttpError(
      400,
      "invalid_address",
      "Addresses cannot contain '+' (plus-addressing is routed to the base address)",
    );
  }
  return { localPart, domain };
}

export async function assertAddressAvailable(db: Db, address: string): Promise<void> {
  const [a, u] = await Promise.all([
    db.select({ n: count() }).from(schema.address).where(eq(schema.address.address, address)).get(),
    db.select({ n: count() }).from(schema.user).where(eq(schema.user.email, address)).get(),
  ]);
  if ((a?.n ?? 0) > 0 || (u?.n ?? 0) > 0) {
    throw new ApiHttpError(409, "address_taken", "That address is already in use");
  }
}

export async function assertDomainServed(db: Db, domain: string): Promise<void> {
  const row = await db
    .select({ name: schema.domain.name })
    .from(schema.domain)
    .where(eq(schema.domain.name, domain))
    .get();
  if (!row) {
    throw new ApiHttpError(
      400,
      "unknown_domain",
      `Domain ${domain} is not served by this deployment`,
    );
  }
}

// ------------------------------------------------------------------ invites

export interface CreatedInvite extends Invite {
  token: string;
}

/**
 * Revokes the user's unused invites (and the enrollment sessions opened from them) and creates a
 * fresh one. It does not touch the user's existing factors: they are reset when the new invite's
 * first factor is saved.
 */
export async function createInvite(env: Env, userId: string): Promise<CreatedInvite> {
  const db = getDb(env);
  const token = randomToken(32);
  const now = new Date();
  const expiresAt = new Date(now.getTime() + INVITE_TTL_MS);
  await db.batch([
    db.delete(schema.session).where(
      inArray(
        schema.session.inviteId,
        db
          .select({ id: schema.invite.id })
          .from(schema.invite)
          .where(and(eq(schema.invite.userId, userId), isNull(schema.invite.usedAt))),
      ),
    ),
    db
      .delete(schema.invite)
      .where(and(eq(schema.invite.userId, userId), isNull(schema.invite.usedAt))),
    db.insert(schema.invite).values({
      id: crypto.randomUUID(),
      tokenHash: await sha256Hex(token),
      userId,
      expiresAt,
      createdAt: now,
    }),
  ]);
  return {
    token,
    url: `${new URL(env.PUBLIC_URL).origin}/invite/${token}`,
    expiresAt: expiresAt.toISOString(),
  };
}

/** Best-effort: mail the invite link to the user's external recovery address. */
export function sendInviteEmail(env: Env, to: string, name: string, invite: Invite): void {
  const app = env.APP_NAME || "S8S Mail";
  runInBackground(
    sendSystemMailLazy(env, {
      to,
      subject: `You have been invited to ${app}`,
      text:
        `Hello ${name},\n\nAn administrator created a ${app} account for you.\n` +
        `Open this one-time link to finish setting it up (valid until ${invite.expiresAt}):\n\n` +
        `${invite.url}\n\nIf you did not expect this message, ignore it.`,
    }),
  );
}

// ------------------------------------------------------------------ admin user view

function isBannedNow(banned: boolean | null, banExpires: Date | null): boolean {
  return !!banned && (!banExpires || banExpires.getTime() > Date.now());
}

/** Loads users in the `adminUser` shape (all users, or the given ids). */
export async function loadAdminUsers(db: Db, ids?: string[]): Promise<AdminUser[]> {
  if (ids && ids.length === 0) return [];
  const byId = <T>(col: T) => (ids ? inArray(col as never, ids) : undefined);
  const now = new Date();

  const [users, aliasRows, passkeyRows, passwordRows, inviteRows, sessionRows] = await Promise.all([
    db.select().from(schema.user).where(byId(schema.user.id)).orderBy(asc(schema.user.createdAt)),
    db
      .select({ userId: schema.mailAccount.ownerUserId, n: count() })
      .from(schema.address)
      .innerJoin(schema.mailAccount, eq(schema.address.accountId, schema.mailAccount.id))
      .where(and(eq(schema.address.kind, "alias"), byId(schema.mailAccount.ownerUserId)))
      .groupBy(schema.mailAccount.ownerUserId),
    db
      .selectDistinct({ userId: schema.passkey.userId })
      .from(schema.passkey)
      .where(byId(schema.passkey.userId)),
    db
      .selectDistinct({ userId: schema.opaqueCredential.userId })
      .from(schema.opaqueCredential)
      .where(byId(schema.opaqueCredential.userId)),
    db
      .selectDistinct({ userId: schema.invite.userId })
      .from(schema.invite)
      .where(
        and(
          isNull(schema.invite.usedAt),
          gt(schema.invite.expiresAt, now),
          byId(schema.invite.userId),
        ),
      ),
    db
      .select({ userId: schema.session.userId, last: max(schema.session.createdAt) })
      .from(schema.session)
      .where(byId(schema.session.userId))
      .groupBy(schema.session.userId),
  ]);

  const aliasCount = new Map(aliasRows.map((r) => [r.userId, r.n]));
  const hasPasskey = new Set(passkeyRows.map((r) => r.userId));
  const hasPassword = new Set(passwordRows.map((r) => r.userId));
  const hasInvite = new Set(inviteRows.map((r) => r.userId));
  // max() over a timestamp_ms column comes back as a raw epoch-ms number
  const lastSignIn = new Map(
    sessionRows.map((r) => [r.userId, r.last as unknown as number | null]),
  );

  return users.map((u) => {
    const status = isBannedNow(u.banned, u.banExpires)
      ? "disabled"
      : !hasPasskey.has(u.id) && !hasPassword.has(u.id) && hasInvite.has(u.id)
        ? "invited"
        : "active";
    const last = lastSignIn.get(u.id);
    return {
      id: u.id,
      name: u.name,
      email: u.email,
      role: u.role === "admin" ? "admin" : "user",
      status,
      aliasCount: aliasCount.get(u.id) ?? 0,
      recoveryEmail: u.recoveryEmail ?? null,
      lastSignInAt: last ? new Date(last).toISOString() : null,
      createdAt: u.createdAt.toISOString(),
    } satisfies AdminUser;
  });
}

// ------------------------------------------------------------------ create / delete

export interface NewUserInput {
  name: string;
  primaryAddress: string;
  recoveryEmail: string;
  role: Role;
}

/**
 * Creates a Better Auth user WITHOUT a password (so nothing is hashed), its mail account and
 * primary address, plus a one-time invite. Used by POST /api/admin/users and the bootstrap.
 */
export async function createUserWithAccount(
  env: Env,
  input: NewUserInput,
  opts: { createDomain?: boolean } = {},
): Promise<{ user: AdminUser; invite: CreatedInvite }> {
  const db = getDb(env);
  const address = input.primaryAddress.toLowerCase();
  const { localPart, domain } = splitAddress(address);
  if (opts.createDomain) {
    await db
      .insert(schema.domain)
      .values({ name: domain, createdAt: new Date() })
      .onConflictDoNothing();
  } else {
    await assertDomainServed(db, domain);
  }
  await assertAddressAvailable(db, address);

  const auth = await getAuth(env);
  const ctx = await auth.$context;
  const created = await ctx.internalAdapter.createUser(
    {
      email: address,
      name: input.name,
      emailVerified: true,
      role: input.role,
      recoveryEmail: input.recoveryEmail.toLowerCase(),
    },
    { method: "admin" },
  );

  const accountId = newAccountId();
  const now = new Date();
  try {
    await db.batch([
      db.insert(schema.mailAccount).values({
        id: accountId,
        name: input.name,
        isPersonal: true,
        ownerUserId: created.id,
        createdAt: now,
      }),
      db.insert(schema.address).values({
        address,
        localPart,
        domain,
        accountId,
        kind: "primary",
        createdAt: now,
      }),
    ]);
  } catch (err) {
    // The address may have been taken concurrently: do not leave a half-created user behind.
    await ctx.internalAdapter.deleteUser(created.id).catch(() => {});
    throw err instanceof Error && /UNIQUE|constraint/i.test(err.message)
      ? new ApiHttpError(409, "address_taken", "That address is already in use")
      : err;
  }

  const invite = await createInvite(env, created.id);
  const [user] = await loadAdminUsers(db, [created.id]);
  if (!user) throw new Error("user vanished after creation");
  return { user, invite };
}

/** Wipes the account Durable Object's storage. */
async function wipeAccountStorage(env: Env, accountId: string): Promise<void> {
  try {
    // TODO(storage): AccountDO.deleteAll() RPC is added by the storage module; until it lands
    // the call rejects and is only logged.
    const stub = env.ACCOUNT.get(env.ACCOUNT.idFromName(accountId)) as unknown as {
      deleteAll?: () => Promise<unknown>;
    };
    await stub.deleteAll?.();
  } catch (err) {
    console.error({ msg: "account do deleteAll failed", accountId, ...errorFields(err) });
  }
}

/** Hard-deletes a user: Durable Object data, mail accounts, addresses, then the auth records. */
export async function deleteUserCompletely(env: Env, userId: string): Promise<void> {
  const db = getDb(env);
  const accounts = await db
    .select({ id: schema.mailAccount.id })
    .from(schema.mailAccount)
    .where(eq(schema.mailAccount.ownerUserId, userId));
  for (const a of accounts) await wipeAccountStorage(env, a.id);
  if (accounts.length > 0) {
    const ids = accounts.map((a) => a.id);
    // address rows go with the account (ON DELETE CASCADE); in the same batch, any domain
    // catch-all that pointed at one of them is cleared so it cannot dangle.
    await db.batch([
      db
        .update(schema.domain)
        .set({ catchAllAddress: null })
        .where(
          inArray(
            schema.domain.catchAllAddress,
            db
              .select({ address: schema.address.address })
              .from(schema.address)
              .where(inArray(schema.address.accountId, ids)),
          ),
        ),
      db.delete(schema.mailAccount).where(inArray(schema.mailAccount.id, ids)),
    ]);
  }
  const auth = await getAuth(env);
  const ctx = await auth.$context;
  await ctx.internalAdapter.deleteUser(userId); // sessions, accounts, passkeys, api keys, oauth tokens
  await db.delete(schema.invite).where(eq(schema.invite.userId, userId));
  await db.delete(schema.apikey).where(eq(schema.apikey.referenceId, userId));
}

export async function countUsers(db: Db): Promise<number> {
  const row = await db
    .select({ n: sql<number>`count(*)` })
    .from(schema.user)
    .get();
  return row?.n ?? 0;
}
