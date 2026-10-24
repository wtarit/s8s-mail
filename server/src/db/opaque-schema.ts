import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { user } from "./auth-schema";

/** OPAQUE records are tied to immutable user IDs, never mutable email addresses. */
export const opaqueCredential = sqliteTable("opaque_credential", {
  userId: text("user_id")
    .primaryKey()
    .references(() => user.id, { onDelete: "cascade" }),
  registrationRecord: text("registration_record").notNull(),
});

/**
 * Server handshake secrets: encrypted, single-use (DELETE ... RETURNING) and short-lived.
 * `login` is anonymous, `password` (combined registration + current-password proof) and
 * `stepup` are bound to one session.
 */
export const opaqueChallenge = sqliteTable(
  "opaque_challenge",
  {
    id: text("id").primaryKey(),
    purpose: text("purpose", { enum: ["login", "password", "stepup"] }).notNull(),
    userId: text("user_id"),
    sessionId: text("session_id"),
    encryptedState: text("encrypted_state").notNull(),
    expiresAt: integer("expires_at").notNull(),
  },
  (t) => [
    index("opaque_challenge_expiry_idx").on(t.expiresAt),
    index("opaque_challenge_user_idx").on(t.userId),
  ],
);

/**
 * A half-finished sign-in or recovery of a 2FA user: the first factor is verified, no session
 * exists yet. The browser holds the raw token in an HttpOnly cookie; only sha256(token) is
 * stored. Consumed (DELETE ... RETURNING) when the second factor creates the session.
 */
export const pendingSignIn = sqliteTable(
  "pending_sign_in",
  {
    /** hex sha256 of the cookie token */
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    passwordVerifiedAt: integer("password_verified_at"),
    recoveryVerifiedAt: integer("recovery_verified_at"),
    expiresAt: integer("expires_at").notNull(),
  },
  (t) => [
    index("pending_sign_in_user_idx").on(t.userId),
    index("pending_sign_in_expiry_idx").on(t.expiresAt),
  ],
);
