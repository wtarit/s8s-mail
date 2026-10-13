import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

/**
 * D1 global directory schema (Better Auth tables, users -> accounts, domains,
 * address -> account routing). Placeholder table so migrations can be generated and applied;
 * replace it with the real tables.
 */
export const directoryMeta = sqliteTable("directory_meta", {
  key: text("key").primaryKey(),
  value: text("value").notNull(),
  updatedAt: integer("updated_at").notNull(),
});
