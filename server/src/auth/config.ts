// Light constants/helpers shared with code that must not pull Better Auth into the cold start.

export const AUTH_BASE_PATH = "/api/auth";
export const OAUTH_SCOPES = ["openid", "profile", "email", "offline_access"] as const;
export const APP_PASSWORD_PREFIX = "s8s_";

export function publicOrigin(env: Pick<Env, "PUBLIC_URL">): string {
  return new URL(env.PUBLIC_URL).origin;
}

/** Lifetime of JMAP access tokens (JWTs), in seconds. Refresh tokens stay DB-backed and long-lived. */
export const JMAP_ACCESS_TOKEN_TTL = 600;

/**
 * The OAuth resource (RFC 8707) that JMAP access tokens are issued for: it is the JWT `aud`.
 * Clients send it as `resource=` on the authorize and token requests.
 */
export function jmapResourceIdentifier(env: Pick<Env, "PUBLIC_URL">): string {
  return `${publicOrigin(env)}/jmap`;
}

/** Seed definition of the JMAP resource row (`oauth_resource`). */
export function jmapResource(env: Pick<Env, "PUBLIC_URL">) {
  return {
    identifier: jmapResourceIdentifier(env),
    name: "JMAP API",
    accessTokenTtl: JMAP_ACCESS_TOKEN_TTL,
  };
}
