import type { FactorName } from "#shared";
import { IconFingerprint } from "@tabler/icons-react";
import { useState, type FormEvent } from "react";
import { FormError } from "@/components/form-error";
import { LoadingButton } from "@/components/loading-button";
import { Button } from "@/components/ui/button";
import { Field, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Separator } from "@/components/ui/separator";
import { authErrorMessage, getAuthClient } from "@/lib/auth-client";
import { useT } from "@/i18n";

interface SecondFactorStepProps {
  /** How the first half happened: a correct password, or the recovery (magic) link. */
  via: "password" | "recovery";
  email: string;
  /** What can still finish the sign-in; any ONE of them is enough. */
  factors: readonly FactorName[];
  /** The session now exists. `data` is Better Auth's answer (may be an OAuth redirect). */
  onSignedIn: (data: unknown) => void;
  onBack?: () => void;
}

/**
 * Second step for a 2FA user: a passkey button and/or the password form. The passkey POST carries
 * the signed OAuth query on its own (oauthProviderClient); a password during a recovery is the
 * normal OPAQUE login, which the server completes because of the pending cookie.
 */
export function SecondFactorStep({
  via,
  email,
  factors,
  onSignedIn,
  onBack,
}: SecondFactorStepProps) {
  const t = useT();
  const client = getAuthClient();
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState<FactorName | null>(null);
  const [error, setError] = useState<string>();
  const [fieldError, setFieldError] = useState<string>();
  const usePasskey = factors.includes("passkey");
  const usePassword = factors.includes("password");

  async function signInWithPasskey() {
    setError(undefined);
    setBusy("passkey");
    try {
      const result = await client.signIn.passkey();
      if (result.error) {
        setError(authErrorMessage(result.error, t("login.passkeyFailed")));
      } else {
        onSignedIn(result.data);
        return;
      }
    } catch {
      setError(t("login.passkeyFailed"));
    }
    setBusy(null);
  }

  async function signInWithPassword(e: FormEvent) {
    e.preventDefault();
    setError(undefined);
    if (!password) {
      setFieldError(t("login.passwordRequired"));
      return;
    }
    setFieldError(undefined);
    setBusy("password");
    try {
      const result = await client.signIn.opaque({ email, password });
      if (result.error) {
        setError(
          result.error.code === "INVALID_EMAIL_OR_PASSWORD" || result.error.status === 401
            ? t("login.invalidCredentials")
            : authErrorMessage(result.error, t("login.signInFailed")),
        );
      } else if ((result.data as { passkeyRequired?: boolean } | null)?.passkeyRequired) {
        setError(t("login.signInFailed"));
      } else {
        onSignedIn(result.data);
        return;
      }
    } catch {
      setError(t("login.signInFailed"));
    }
    setBusy(null);
  }

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-1">
        <h1 className="text-2xl font-semibold">{t("secondFactor.title")}</h1>
        <p className="text-muted-foreground text-[15px]">
          {t(via === "password" ? "secondFactor.bodyPassword" : "secondFactor.bodyRecovery")}
        </p>
        <p className="font-mono text-[13px] break-all">{email}</p>
      </div>

      {usePasskey ? (
        <LoadingButton
          type="button"
          size="lg"
          className="h-11 rounded-lg text-[15px]"
          loading={busy === "passkey"}
          disabled={busy !== null}
          onClick={() => void signInWithPasskey()}
        >
          <IconFingerprint size={20} stroke={1.75} />
          {t("secondFactor.passkey")}
        </LoadingButton>
      ) : null}

      {usePasskey && usePassword ? (
        <div className="flex items-center gap-3" aria-hidden="true">
          <Separator className="flex-1" />
          <span className="text-muted-foreground text-[13px]">{t("login.or")}</span>
          <Separator className="flex-1" />
        </div>
      ) : null}

      {usePassword ? (
        <form onSubmit={signInWithPassword} noValidate className="flex flex-col gap-4">
          <Field>
            <FieldLabel htmlFor="second-factor-password">{t("login.passwordLabel")}</FieldLabel>
            <Input
              id="second-factor-password"
              type="password"
              autoComplete="current-password"
              className="h-11 rounded-lg text-[15px]"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              aria-invalid={fieldError ? true : undefined}
            />
            {fieldError ? (
              <p role="alert" className="text-destructive text-sm">
                {fieldError}
              </p>
            ) : null}
          </Field>
          <LoadingButton
            type="submit"
            variant="outline"
            size="lg"
            className="h-11 rounded-lg text-[15px]"
            loading={busy === "password"}
            disabled={busy !== null}
          >
            {t("login.submit")}
          </LoadingButton>
        </form>
      ) : null}

      <FormError message={error} />

      {onBack ? (
        <Button type="button" variant="ghost" className="rounded-lg" onClick={onBack}>
          {t("secondFactor.back")}
        </Button>
      ) : null}
    </div>
  );
}
