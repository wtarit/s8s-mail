import type { BetterAuthClientPlugin } from "better-auth/client";
import { t } from "@/i18n";
import { createCryptoWorker, OpaqueError } from "./worker-client";

type Actions = NonNullable<BetterAuthClientPlugin["getActions"]>;
/** `passkeyRequired`: the password was right but the user has a passkey, which finishes sign-in. */
type LoginResult = { user?: unknown; redirect: boolean; url?: string; passkeyRequired?: boolean };
type AuthResult<T> = {
  data: T | null;
  error: { message?: string; code?: string; status?: number } | null;
};
type Challenge = { challengeId: string; loginResponse?: string; registrationResponse?: string };
type Crypto = ReturnType<typeof createCryptoWorker>;

function failure(error: unknown) {
  const code = error instanceof OpaqueError ? error.code : "OPAQUE_FAILED";
  const message =
    code === "INVALID_EMAIL_OR_PASSWORD"
      ? t("login.invalidCredentials")
      : code === "OPAQUE_UNAVAILABLE"
        ? t("opaque.unavailable")
        : code === "OPAQUE_TIMEOUT"
          ? t("opaque.timeout")
          : t("opaque.failed");
  return {
    data: null,
    error: { code, message, status: code === "INVALID_EMAIL_OR_PASSWORD" ? 401 : 0 },
  };
}

async function perform<T>(operation: (crypto: Crypto) => Promise<AuthResult<T>>) {
  let crypto: Crypto | undefined;
  try {
    crypto = createCryptoWorker();
    return await operation(crypto);
  } catch (error) {
    return failure(error);
  } finally {
    crypto?.close();
  }
}

export function opaqueClient() {
  return {
    id: "opaque",
    getActions: ($fetch: Parameters<Actions>[0], $store: Parameters<Actions>[1]) => {
      /** One login handshake against `base` (`/opaque/login` or `/step-up/password`). */
      async function loginExchange<T>(
        crypto: Crypto,
        base: string,
        password: string,
        extra: Record<string, unknown>,
      ): Promise<AuthResult<T>> {
        const local = await crypto.run({ type: "login-start", password });
        const start = await $fetch<Challenge>(`${base}/start`, {
          method: "POST",
          body: { ...extra, startLoginRequest: local.startLoginRequest },
          timeout: 30000,
        });
        if (start.error) return start;
        if (!start.data?.challengeId) throw new OpaqueError("OPAQUE_FAILED");
        const proof = await crypto.run({ type: "finish", loginResponse: start.data.loginResponse });
        return $fetch<T>(`${base}/finish`, {
          method: "POST",
          body: {
            challengeId: start.data.challengeId,
            finishLoginRequest: proof.finishLoginRequest,
          },
          timeout: 30000,
        });
      }
      return {
        signIn: {
          opaque: ({ email, password }: { email: string; password: string }) =>
            perform<LoginResult>(async (crypto) => {
              const finish = await loginExchange<LoginResult>(crypto, "/opaque/login", password, {
                email,
              });
              // A 2FA user has no session yet: the passkey step creates it.
              if (!finish.error && !finish.data?.passkeyRequired) $store.notify("$sessionSignal");
              return finish;
            }),
        },
        opaque: {
          /** Prove the password again for the CURRENT session (account-change step-up). */
          stepUp: ({ password }: { password: string }) =>
            perform<{ ok: true }>(async (crypto) => {
              const finish = await loginExchange<{ ok: true }>(
                crypto,
                "/step-up/password",
                password,
                {},
              );
              if (!finish.error) $store.notify("$sessionSignal");
              return finish;
            }),
          setPassword: ({
            newPassword,
            currentPassword,
          }: {
            newPassword: string;
            currentPassword?: string;
          }) =>
            perform<{ ok: true }>(async (crypto) => {
              const local = await crypto.run({
                type: "password-start",
                newPassword,
                currentPassword,
              });
              const start = await $fetch<Challenge>("/opaque/password/start", {
                method: "POST",
                body: local,
                timeout: 30000,
              });
              if (start.error) return start;
              if (!start.data?.challengeId) throw new OpaqueError("OPAQUE_FAILED");
              const proof = await crypto.run({
                type: "finish",
                registrationResponse: start.data.registrationResponse,
                loginResponse: start.data.loginResponse,
              });
              const finish = await $fetch<{ ok: true }>("/opaque/password/finish", {
                method: "POST",
                body: { challengeId: start.data.challengeId, ...proof },
                timeout: 30000,
              });
              if (!finish.error) $store.notify("$sessionSignal");
              return finish;
            }),
        },
      };
    },
  } satisfies BetterAuthClientPlugin;
}
