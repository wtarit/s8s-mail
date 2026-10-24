import type { MeResponse } from "@s8s/shared";
import { asc, eq } from "drizzle-orm";
import { Hono } from "hono";
import { loadUserFactors } from "../auth/factors/load";
import { accountChangeStatus, isFresh } from "../auth/factors/policy";
import type { AppEnv } from "../auth/types";
import { getDb, schema } from "../db";
import { requireSession } from "./guards";
import { maskEmail } from "./util";

/** Signed-in self-service (`/me`). The public invite endpoints are in `invite-routes.ts`. */
export const accountRoutes = new Hono<AppEnv>();

// ------------------------------------------------------------------ me / account

accountRoutes.get("/me", requireSession, async (c) => {
  const db = getDb(c.env);
  const u = c.var.sessionUser;
  const [row, have, accounts, addresses] = await Promise.all([
    db
      .select({ recoveryEmail: schema.user.recoveryEmail })
      .from(schema.user)
      .where(eq(schema.user.id, u.id))
      .get(),
    loadUserFactors(c.env, u.id),
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
  const now = Date.now();
  const { stamps, impersonated } = c.var.session;
  const status = accountChangeStatus(have, stamps, now);
  const freshness = (at: number | null) => ({
    verifiedAt: at === null ? null : new Date(at).toISOString(),
    fresh: isFresh(at, now),
  });
  const body: MeResponse = {
    user: {
      id: u.id,
      name: u.name,
      email: u.email,
      role: u.role,
      recoveryEmailMasked: row?.recoveryEmail ? maskEmail(row.recoveryEmail) : null,
      hasPassword: have.password,
      passkeyCount: have.passkeys,
      factors: {
        password: freshness(stamps.password),
        passkey: freshness(stamps.passkey),
        recovery: freshness(stamps.recovery),
      },
      accountChange: {
        allowed: status.allowed && !impersonated,
        stale: impersonated ? [] : status.stale,
        oneOf: status.oneOf,
        currentPasswordRequired: status.currentPasswordRequired,
      },
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
