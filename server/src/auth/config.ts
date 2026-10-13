// Light constants/helpers shared with code that must not pull Better Auth into the cold start.

export const AUTH_BASE_PATH = "/api/auth";
export const OAUTH_SCOPES = ["openid", "profile", "email", "offline_access"] as const;
export const APP_PASSWORD_PREFIX = "s8s_";

export function publicOrigin(env: Pick<Env, "PUBLIC_URL">): string {
  return new URL(env.PUBLIC_URL).origin;
}
