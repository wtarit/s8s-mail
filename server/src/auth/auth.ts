import { apiKey } from "@better-auth/api-key";
import {
  oauthProvider,
  oauthProviderAuthServerMetadata,
  oauthProviderOpenIdConfigMetadata,
} from "@better-auth/oauth-provider";
import { passkey } from "@better-auth/passkey";
import { betterAuth, type BetterAuthOptions } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { admin, jwt, magicLink } from "better-auth/plugins";
import { getDb, schema } from "../db";
import {
  APP_PASSWORD_PREFIX,
  AUTH_BASE_PATH,
  OAUTH_SCOPES,
  jmapResource,
  publicOrigin,
} from "./config";
import { inviteSession } from "./invite-session-plugin";
import { runInBackground } from "./request-context";
import { sendSystemMailLazy } from "./system-mail";

/** The slice of `Env` the auth setup reads. */
export type AuthEnv = Pick<
  Env,
  "DB" | "PUBLIC_URL" | "WEBMAIL_ORIGIN" | "APP_NAME" | "BETTER_AUTH_SECRET"
> &
  Partial<Env> & {
    /** Origin of a separately deployed ("headless") SPA, if any. Optional. */
    SPA_ORIGIN?: string;
  };

/**
 * Builds the Better Auth instance. `database` is injected so the schema generator
 * (`auth.config.ts`) can build the same plugin set without a D1 binding.
 */
export function makeAuth(env: AuthEnv, database: BetterAuthOptions["database"]) {
  const origin = publicOrigin(env);
  const rpID = new URL(env.PUBLIC_URL).hostname;
  const appName = env.APP_NAME || "S8S Mail";

  return betterAuth({
    appName,
    baseURL: env.PUBLIC_URL,
    basePath: AUTH_BASE_PATH,
    secret: env.BETTER_AUTH_SECRET,
    // PUBLIC_URL (bundled SPA), the webmail, and an optional separately hosted SPA.
    trustedOrigins: [origin, env.WEBMAIL_ORIGIN, env.SPA_ORIGIN].filter((o): o is string => !!o),
    // Browser-facing auth errors (OAuth authorize, magic link verify) land on the SPA's /error page.
    onAPIError: { errorURL: "/error" },
    database,

    advanced: {
      // Workers: the client IP is in cf-connecting-ip. Used for rate limiting.
      ipAddress: { ipAddressHeaders: ["cf-connecting-ip"] },
      // Run Better Auth's own background work (and our mail sending) after the response.
      backgroundTasks: { handler: (p) => runInBackground(p) },
    },

    // Database-backed counters (no KV bound). Only sign-in-ish endpoints are limited tightly;
    // read-only endpoints are exempt so the SPA/JMAP do not cause a D1 write per request.
    rateLimit: {
      enabled: true,
      storage: "database",
      window: 60,
      max: 120,
      customRules: {
        "/sign-in/email": { window: 60, max: 10 },
        "/sign-in/magic-link": { window: 300, max: 5 },
        "/magic-link/verify": { window: 60, max: 20 },
        "/get-session": false,
        "/jwks": false,
        "/oauth2/userinfo": false,
        "/list-sessions": false,
      },
    },

    // Sign-up is disabled everywhere: admins create users (see src/api).
    emailAndPassword: {
      enabled: true,
      disableSignUp: true,
      minPasswordLength: 10,
      maxPasswordLength: 256,
      // password hasher: Better Auth default (native node:crypto scrypt on workerd). Never PBKDF2.
    },

    user: {
      additionalFields: {
        // External address that receives magic links and invites. Set by admins only.
        recoveryEmail: { type: "string", required: false, input: false },
      },
    },

    plugins: [
      admin({ defaultRole: "user", adminRoles: ["admin"] }),
      magicLink({
        disableSignUp: true,
        expiresIn: 900,
        storeToken: "hashed",
        async sendMagicLink({ email, url }, ctx) {
          // Never reveal whether the account exists: always return normally.
          try {
            const user = ctx
              ? await ctx.context.internalAdapter.findUserByEmail(email.toLowerCase())
              : null;
            const recoveryEmail = (user?.user as { recoveryEmail?: string | null } | undefined)
              ?.recoveryEmail;
            if (!user || !recoveryEmail || (user.user as { banned?: boolean | null }).banned)
              return;
            runInBackground(
              sendSystemMailLazy(env as Env, {
                to: recoveryEmail,
                subject: `Your ${appName} sign-in link`,
                text:
                  `Someone asked to sign in to ${appName} as ${email}.\n\n` +
                  `Open this link within 15 minutes to sign in:\n${url}\n\n` +
                  `If this was not you, ignore this message.`,
              }),
            );
          } catch (err) {
            console.error(
              "magic link: could not queue email",
              err instanceof Error ? err.message : err,
            );
          }
        },
      }),
      passkey({ rpID, rpName: appName, origin }),
      apiKey({
        // App passwords for JMAP clients that use HTTP Basic.
        defaultPrefix: APP_PASSWORD_PREFIX,
        requireName: true,
        // Verified with plain SHA-256 (the plugin default): keys are 64 random chars, so a fast
        // hash is fine. Never scrypt per JMAP request.
        rateLimit: { enabled: false },
      }),
      // JWKS + ID-token signing for the OAuth provider. No `set-auth-jwt` header on get-session:
      // it would sign a JWT on every session lookup.
      jwt({ disableSettingJwtHeader: true }),
      oauthProvider({
        loginPage: "/login",
        consentPage: "/consent",
        scopes: [...OAUTH_SCOPES],
        allowDynamicClientRegistration: false,
        allowUnauthenticatedClientRegistration: false,
        // Clients that send `resource=<origin>/jmap` get a JWT access token (aud = that resource)
        // that JMAP verifies locally; without it the token is opaque and JMAP answers 401. Seeded
        // insert-only: edit the row (or `ensureBulwarkClient`) to change it later. Clients must be
        // linked to the resource (`oauth_client_resource`); `ensureBulwarkClient` does that for the
        // webmail client.
        resources: [jmapResource(env)],
        // Only admins manage OAuth clients; our /api/admin routes enforce this too.
        clientPrivileges: ({ user }) => user?.role === "admin",
      }),
      inviteSession(),
    ],
  });
}

export type Auth = ReturnType<typeof makeAuth>;

const cache = new WeakMap<object, Auth>();

/** The per-isolate Auth instance for this env (built on first use, then reused). */
export function createAuth(env: AuthEnv): Auth {
  let auth = cache.get(env);
  if (!auth) {
    const db = getDb(env);
    auth = makeAuth(env, drizzleAdapter(db, { provider: "sqlite", schema }));
    cache.set(env, auth);
  }
  return auth;
}

/** GET /.well-known/openid-configuration at the origin root. */
export function openIdConfigResponse(auth: Auth, request: Request): Promise<Response> {
  return oauthProviderOpenIdConfigMetadata(auth)(request);
}

/** GET /.well-known/oauth-authorization-server (root and RFC 8414 path-inserted form). */
export function authServerMetadataResponse(auth: Auth, request: Request): Promise<Response> {
  return oauthProviderAuthServerMetadata(auth)(request);
}
