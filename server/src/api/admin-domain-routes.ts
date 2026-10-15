import { addDomainRequest, updateDomainRequest } from "@s8s/shared";
import { asc, count, eq } from "drizzle-orm";
import { Hono } from "hono";
import type { AppEnv } from "../auth/types";
import { getDb, schema } from "../db";
import { ApiHttpError } from "./errors";
import { validate } from "./util";

/** Admin domain and address routes; mounted under `/admin` (guarded by `requireAdmin` there). */
export const adminDomainRoutes = new Hono<AppEnv>();

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
      catchAllAddress: d.catchAllAddress,
      createdAt: d.createdAt.toISOString(),
    })),
  };
}

adminDomainRoutes.get("/domains", async (c) => c.json(await listDomains(c.env)));

adminDomainRoutes.post("/domains", validate("json", addDomainRequest), async (c) => {
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

adminDomainRoutes.patch("/domains/:name", validate("json", updateDomainRequest), async (c) => {
  const name = c.req.param("name").toLowerCase();
  const { catchAllAddress } = c.req.valid("json");
  const db = getDb(c.env);
  const exists = await db
    .select({ name: schema.domain.name })
    .from(schema.domain)
    .where(eq(schema.domain.name, name))
    .get();
  if (!exists) throw new ApiHttpError(404, "not_found", "Domain not found");
  if (catchAllAddress !== null) {
    const target = await db
      .select({ address: schema.address.address })
      .from(schema.address)
      .where(eq(schema.address.address, catchAllAddress))
      .get();
    if (!target) {
      throw new ApiHttpError(
        400,
        "invalid_catch_all",
        "The catch-all must be an existing address of this deployment",
      );
    }
  }
  await db.update(schema.domain).set({ catchAllAddress }).where(eq(schema.domain.name, name));
  return c.json(await listDomains(c.env));
});

adminDomainRoutes.get("/addresses", async (c) => {
  const rows = await getDb(c.env)
    .select({
      address: schema.address.address,
      kind: schema.address.kind,
      accountName: schema.mailAccount.name,
    })
    .from(schema.address)
    .innerJoin(schema.mailAccount, eq(schema.address.accountId, schema.mailAccount.id))
    .orderBy(asc(schema.address.address));
  return c.json({ addresses: rows });
});

adminDomainRoutes.delete("/domains/:name", async (c) => {
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
