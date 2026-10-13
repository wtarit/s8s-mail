import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { user } from "./auth-schema";

// Better Auth's tables (user, session, account, passkey, apikey, jwks, oauth_*, rate_limit, ...).
// Generated: `pnpm dlx auth@1.7.7 generate --config auth.config.ts --output src/db/auth-schema.ts`
// (run from server/ after changing the plugin set in src/auth/auth.ts), then `pnpm db:generate:d1`.
export * from "./auth-schema";

/**
 * D1 global directory: which domains we serve, which JMAP accounts exist and
 * which addresses deliver into them. Mail data never lives here; it is in the
 * per-account Durable Object (see src/store/).
 *
 * `mail_account.owner_user_id` references Better Auth's `user.id` (no FK: deleting a user is
 * done explicitly by the admin API, which must also wipe the account's Durable Object).
 *
 * Addresses and domain names are stored lowercased.
 */

export const domain = sqliteTable("domain", {
  name: text("name").primaryKey(),
  /**
   * Catch-all: an existing `address.address` (primary or alias, on any served domain) that
   * receives mail to unknown local parts on this domain. null = reject unknown recipients.
   * Deliberately no FK (it would be circular with `address.domain`): the admin API clears it
   * in the same batch that deletes the address (alias removed, user deleted).
   */
  catchAllAddress: text("catch_all_address"),
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

/**
 * One-time invite links. The raw token is only ever shown to the admin (and mailed to the
 * recovery address); we store sha256(token). Accepting an invite sets `used_at` and starts a session.
 */
export const invite = sqliteTable(
  "invite",
  {
    id: text("id").primaryKey(),
    /** hex sha256 of the raw token */
    tokenHash: text("token_hash").notNull().unique(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    expiresAt: integer("expires_at", { mode: "timestamp_ms" }).notNull(),
    usedAt: integer("used_at", { mode: "timestamp_ms" }),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  },
  (t) => [index("invite_user_idx").on(t.userId)],
);
