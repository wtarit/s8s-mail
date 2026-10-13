import { DurableObject } from "cloudflare:workers";
import { drizzle, type DrizzleSqliteDODatabase } from "drizzle-orm/durable-sqlite";
import { migrate } from "drizzle-orm/durable-sqlite/migrator";
import migrations from "../../drizzle/do/migrations";
import { eq } from "drizzle-orm";
import * as schema from "./schema";

/**
 * One SQLite-backed Durable Object per JMAP account. The single writer for that
 * account's mail data. Reached with `env.ACCOUNT.get(env.ACCOUNT.idFromName(accountId))`.
 */
export class AccountDO extends DurableObject<Env> {
  readonly db: DrizzleSqliteDODatabase<typeof schema>;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.db = drizzle(ctx.storage, { schema, logger: false });
    // Runs pending drizzle migrations before any request is delivered.
    void ctx.blockConcurrencyWhile(async () => {
      await migrate(this.db, migrations);
    });
  }

  /** RPC: names of the user tables (excludes SQLite, Cloudflare and drizzle internals). */
  listTables(): string[] {
    return this.ctx.storage.sql
      .exec<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
      .toArray()
      .map((r) => r.name)
      .filter(
        (n) => !n.startsWith("sqlite_") && !n.startsWith("_cf_") && !n.startsWith("__drizzle"),
      );
  }

  /** RPC: write a value to the placeholder `meta` table. */
  setMeta(key: string, value: string): void {
    const updatedAt = Date.now();
    this.db
      .insert(schema.meta)
      .values({ key, value, updatedAt })
      .onConflictDoUpdate({ target: schema.meta.key, set: { value, updatedAt } })
      .run();
  }

  /** RPC: read a value from the placeholder `meta` table. */
  getMeta(key: string): string | null {
    const row = this.db.select().from(schema.meta).where(eq(schema.meta.key, key)).get();
    return row?.value ?? null;
  }
}
