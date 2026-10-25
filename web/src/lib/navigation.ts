import { AUTH_BASE_PATH } from "@/lib/auth-client";
import { getApiBase } from "@/lib/api-base";

/**
 * Params added by Better Auth's oauth-provider when it sends the browser to our
 * login/consent pages. `sig` plus `ba_param` mark a signed authorization query.
 */
const SIGNED_ONLY_PARAMS = ["sig", "exp", "ba_iat", "ba_pl", "ba_param"];

/** True when the page URL carries a signed OAuth authorization query. */
export function hasSignedOAuthQuery(search: string): boolean {
  const params = new URLSearchParams(search);
  return params.has("sig") && params.has("ba_param");
}

/**
 * Return `next` only if it is a same-origin relative path (never `//host` or a scheme),
 * otherwise `fallback`. Prevents open redirects through the `next` parameter.
 */
export function safeNextPath(
  next: string | null | undefined,
  fallback = "/account/profile",
): string {
  if (!next) return fallback;
  if (!next.startsWith("/") || next.startsWith("//") || next.startsWith("/\\")) return fallback;
  return next;
}

/**
 * Rebuild the plain authorization request (client_id, redirect_uri, scope, ...) out of a
 * signed query, for resuming the flow after a sign-in that cannot carry the signed query
 * (a magic link opened from an email). `prompt=login` and `max_age` are dropped because
 * the user has just authenticated.
 */
export function oauthResumeUrl(search: string): string {
  const source = new URLSearchParams(search);
  const params = new URLSearchParams();
  for (const [key, value] of source) {
    if (SIGNED_ONLY_PARAMS.includes(key)) continue;
    if (key === "max_age") continue;
    if (key === "prompt") {
      const rest = value.split(/\s+/).filter((p) => p && p !== "login");
      if (rest.length) params.set("prompt", rest.join(" "));
      continue;
    }
    params.append(key, value);
  }
  return `${getApiBase()}${AUTH_BASE_PATH}/oauth2/authorize?${params.toString()}`;
}

/** True for the authorize URL produced by `oauthResumeUrl` (the only absolute `next` we follow). */
export function isOAuthResumeUrl(target: string): boolean {
  try {
    const url = new URL(target);
    return (
      url.origin === new URL(getApiBase()).origin &&
      url.pathname === `${AUTH_BASE_PATH}/oauth2/authorize`
    );
  } catch {
    return false;
  }
}

/** Full-page navigation to a URL outside the SPA (e.g. the webmail), replacing this history entry. */
export function leaveApp(url: string): void {
  window.location.replace(url);
}

/** `/login` URL that returns to `next` after sign-in. */
export function loginPath(next?: string): string {
  const safe = safeNextPath(next, "");
  return safe && safe !== "/" ? `/login?next=${encodeURIComponent(safe)}` : "/login";
}
