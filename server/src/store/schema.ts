import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

/**
 * Account DO schema (per-account SQLite). Placeholder table that proves migrations run;
 * the real mail schema (mailboxes, emails, threads, change log, FTS5) replaces it.
 */
export const meta = sqliteTable("meta", {
  key: text("key").primaryKey(),
  value: text("value").notNull(),
  updatedAt: integer("updated_at").notNull(),
});
