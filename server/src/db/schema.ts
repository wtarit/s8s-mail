import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

/**
 * D1 global directory: which domains we serve, which JMAP accounts exist and
 * which addresses deliver into them. Mail data never lives here; it is in the
 * per-account Durable Object (see src/store/).
 *
 * Better Auth's tables (user, session, passkey, ...) are added alongside these
 * by the auth module. `mail_account.owner_user_id` references Better Auth's
 * `user.id` (no FK: that table is generated separately).
 *
 * Addresses and domain names are stored lowercased.
 */

export const domain = sqliteTable("domain", {
  name: text("name").primaryKey(),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
});

export const mailAccount = sqliteTable(
  "mail_account",
  {
    /** JMAP accountId; also the Durable Object name (`idFromName`). */
    id: text("id").primaryKey(),
    /** Display name, e.g. the user's name or "Support" for a shared mailbox. */
    name: text("name").notNull(),
    /** false for shared mailboxes (later), which are JMAP accounts with isPersonal=false. */
    isPersonal: integer("is_personal", { mode: "boolean" }).notNull().default(true),
    ownerUserId: text("owner_user_id"),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  },
  (t) => [index("mail_account_owner_idx").on(t.ownerUserId)],
);

export const address = sqliteTable(
  "address",
  {
    /** Full lowercased address without any +tag, e.g. "ana@example.com". */
    address: text("address").primaryKey(),
    localPart: text("local_part").notNull(),
    domain: text("domain")
      .notNull()
      .references(() => domain.name),
    accountId: text("account_id")
      .notNull()
      .references(() => mailAccount.id, { onDelete: "cascade" }),
    /** Exactly one "primary" per account; any number of "alias". Each is a JMAP Identity. */
    kind: text("kind", { enum: ["primary", "alias"] }).notNull(),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  },
  (t) => [index("address_account_idx").on(t.accountId)],
);
