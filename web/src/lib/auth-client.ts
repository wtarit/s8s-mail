import { apiKeyClient } from "@better-auth/api-key/client";
import { oauthProviderClient } from "@better-auth/oauth-provider/client";
import { passkeyClient } from "@better-auth/passkey/client";
import { adminClient, magicLinkClient } from "better-auth/client/plugins";
import { createAuthClient } from "better-auth/react";
import { opaqueClient } from "./opaque/client";
import { getApiBase } from "@/lib/api-base";

export const AUTH_BASE_PATH = "/api/auth";

export function createAppAuthClient(baseURL: string) {
  return createAuthClient({
    baseURL,
    basePath: AUTH_BASE_PATH,
    fetchOptions: { credentials: "include" },
    plugins: [
      opaqueClient(),
      passkeyClient(),
      magicLinkClient(),
      adminClient(),
      apiKeyClient(),
      // Adds the signed OAuth query of the current page to every POST, so sign-in
      // endpoints can continue an in-flight authorization request.
      oauthProviderClient(),
    ],
  });
}

export type AppAuthClient = ReturnType<typeof createAppAuthClient>;

let client: AppAuthClient | undefined;

/** The shared Better Auth client, created lazily once runtime config is known. */
export function getAuthClient(): AppAuthClient {
  client ??= createAppAuthClient(getApiBase());
  return client;
}

/** Reactive Better Auth session (`data` is null when signed out). */
export function useAuthSession() {
  // The client is a module singleton, so this is the same hook on every render.
  // oxlint-disable-next-line react/rules-of-hooks
  return getAuthClient().useSession();
}

/** Reset the cached client (used after reconfiguring the API base). */
export function resetAuthClient(): void {
  client = undefined;
}

interface AuthErrorLike {
  message?: string;
  code?: string;
  status?: number;
}

/** User-facing text for a Better Auth client error, falling back to `fallback`. */
export function authErrorMessage(
  error: AuthErrorLike | null | undefined,
  fallback: string,
): string {
  const message = error?.message?.trim();
  return message ? message : fallback;
}
