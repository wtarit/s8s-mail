import { z } from "zod";

/**
 * Contract for s8s-mail's own REST endpoints (everything under /api that is
 * not Better Auth's /api/auth/*). Server validates requests with these
 * schemas; the SPA validates responses. Better Auth's own endpoints
 * (sign-in, passkeys, magic link, sessions, API keys, OAuth consent) are
 * called through the Better Auth client and are not described here.
 */

export const emailAddress = z.email().transform((s) => s.toLowerCase());
export const domainName = z
  .string()
  .min(3)
  .max(253)
  .regex(/^(?!-)[a-z0-9-]+(\.[a-z0-9-]+)+$/i, "Invalid domain name")
  .transform((s) => s.toLowerCase());

export const role = z.enum(["admin", "user"]);
export type Role = z.infer<typeof role>;

export const userStatus = z.enum(["active", "invited", "disabled"]);
export type UserStatus = z.infer<typeof userStatus>;

/** ISO 8601 timestamps on the wire. */
const isoDate = z.iso.datetime();

// ---------------------------------------------------------------- /api/me

export const meResponse = z.object({
  user: z.object({
    id: z.string(),
    name: z.string(),
    /** Primary mailbox address (also the Better Auth login email). */
    email: z.string(),
    role,
    /** Masked external recovery address, e.g. "a•••@gmail.com"; null if unset. */
    recoveryEmailMasked: z.string().nullable(),
    hasPassword: z.boolean(),
  }),
  accounts: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
      isPersonal: z.boolean(),
      addresses: z.array(z.object({ address: z.string(), kind: z.enum(["primary", "alias"]) })),
    }),
  ),
});
export type MeResponse = z.infer<typeof meResponse>;

// ---------------------------------------------------------------- invites

export const invite = z.object({
  url: z.url(),
  expiresAt: isoDate,
});
export type Invite = z.infer<typeof invite>;

/** GET /api/invite/:token */
export const inviteInfoResponse = z.object({
  status: z.enum(["valid", "expired", "used"]),
  name: z.string(),
  email: z.string(),
  expiresAt: isoDate,
});
export type InviteInfoResponse = z.infer<typeof inviteInfoResponse>;

/** POST /api/invite/:token/accept -> sets the Better Auth session cookie. */
export const inviteAcceptResponse = z.object({ ok: z.literal(true), userId: z.string() });

/** POST /api/account/password  (user without a password sets one; with one, must pass current). */
export const setPasswordRequest = z.object({
  currentPassword: z.string().optional(),
  newPassword: z.string().min(10).max(256),
});

// ---------------------------------------------------------------- admin: users

export const adminUser = z.object({
  id: z.string(),
  name: z.string(),
  email: z.string(),
  role,
  status: userStatus,
  aliasCount: z.number().int().nonnegative(),
  recoveryEmail: z.string().nullable(),
  lastSignInAt: isoDate.nullable(),
  createdAt: isoDate,
});
export type AdminUser = z.infer<typeof adminUser>;

/** GET /api/admin/users */
export const adminUserListResponse = z.object({ users: z.array(adminUser) });

/** POST /api/admin/users */
export const createUserRequest = z.object({
  name: z.string().trim().min(1).max(100),
  /** Must be on a domain served by this deployment. */
  primaryAddress: emailAddress,
  recoveryEmail: emailAddress,
  role: role.default("user"),
});
export type CreateUserRequest = z.input<typeof createUserRequest>;
export const createUserResponse = z.object({ user: adminUser, invite });

/** PATCH /api/admin/users/:id */
export const updateUserRequest = z.object({
  name: z.string().trim().min(1).max(100).optional(),
  role: role.optional(),
  recoveryEmail: emailAddress.optional(),
  disabled: z.boolean().optional(),
});

/** POST /api/admin/users/:id/invite -> new one-time invite (old ones are revoked). */
export const newInviteResponse = z.object({ invite });

/** GET /api/admin/users/:id/aliases ; POST {address} ; DELETE /api/admin/users/:id/aliases/:address */
export const aliasListResponse = z.object({
  aliases: z.array(z.object({ address: z.string(), createdAt: isoDate })),
});
export const addAliasRequest = z.object({ address: emailAddress });

// ---------------------------------------------------------------- admin: domains

export const adminDomain = z.object({
  name: z.string(),
  addressCount: z.number().int().nonnegative(),
  /** Address that receives mail to unknown local parts on this domain; null = reject them. */
  catchAllAddress: z.string().nullable(),
  createdAt: isoDate,
});
export type AdminDomain = z.infer<typeof adminDomain>;
/** GET /api/admin/domains ; POST {name} ; DELETE /api/admin/domains/:name (only when unused) */
export const domainListResponse = z.object({ domains: z.array(adminDomain) });
export type DomainListResponse = z.infer<typeof domainListResponse>;
export const addDomainRequest = z.object({ name: domainName });

/**
 * PATCH /api/admin/domains/:name -> domainListResponse.
 * `catchAllAddress` must be an existing address (primary or alias, any served domain), or null
 * to reject unknown recipients again. 404 unknown domain; 400 `invalid_catch_all` otherwise.
 */
export const updateDomainRequest = z.object({ catchAllAddress: emailAddress.nullable() });
export type UpdateDomainRequest = z.input<typeof updateDomainRequest>;

/** GET /api/admin/addresses: every address in the directory (for the catch-all picker). */
export const adminAddress = z.object({
  address: z.string(),
  kind: z.enum(["primary", "alias"]),
  /** Display name of the account that owns the address. */
  accountName: z.string(),
});
export const adminAddressListResponse = z.object({ addresses: z.array(adminAddress) });
export type AdminAddressListResponse = z.infer<typeof adminAddressListResponse>;

// ---------------------------------------------------------------- admin: OAuth clients ("Sign-in apps")

export const oauthClient = z.object({
  clientId: z.string(),
  name: z.string(),
  redirectUris: z.array(z.url()),
  /** First-party clients skip the consent screen. */
  trusted: z.boolean(),
  /** Public clients (SPA / Bulwark Lite) use PKCE and have no secret. */
  public: z.boolean(),
  createdAt: isoDate,
});
/** GET /api/admin/oauth-clients ; POST ; DELETE /api/admin/oauth-clients/:clientId */
export const oauthClientListResponse = z.object({ clients: z.array(oauthClient) });
export const createOAuthClientRequest = z.object({
  name: z.string().trim().min(1).max(100),
  redirectUris: z.array(z.url()).min(1),
  trusted: z.boolean().default(false),
  public: z.boolean().default(true),
});
/** clientSecret is returned once, only for confidential clients. */
export const createOAuthClientResponse = z.object({
  client: oauthClient,
  clientSecret: z.string().nullable(),
});

// ---------------------------------------------------------------- errors

/** Every non-2xx response from our own endpoints. */
export const apiError = z.object({
  error: z.object({
    code: z.string(),
    message: z.string(),
  }),
});
export type ApiError = z.infer<typeof apiError>;
