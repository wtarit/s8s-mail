import { IconFingerprint } from "@tabler/icons-react";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { Navigate, useLocation, useNavigate, useSearchParams } from "react-router";
import { FormError } from "@/components/form-error";
import { LoadingButton } from "@/components/loading-button";
import { Field, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Separator } from "@/components/ui/separator";
import { authErrorMessage, getAuthClient, useAuthSession } from "@/lib/auth-client";
import { hasSignedOAuthQuery, oauthResumeUrl, safeNextPath } from "@/lib/navigation";
import { useT } from "@/i18n";

type Busy = "passkey" | "password" | "magic" | null;

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** True when Better Auth answered with an OAuth continuation; its client plugin follows `url`. */
function isOAuthRedirect(data: unknown): boolean {
  if (!data || typeof data !== "object") return false;
  const d = data as { redirect?: unknown; url?: unknown };
  return d.redirect === true && typeof d.url === "string";
}

export function LoginPage() {
  const t = useT();
  const navigate = useNavigate();
  const location = useLocation();
  const [params] = useSearchParams();
  const client = getAuthClient();
  const { data: session } = useAuthSession();

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState<Busy>(null);
  const [error, setError] = useState<string>();
  const [emailError, setEmailError] = useState<string>();
  const [passwordError, setPasswordError] = useState<string>();
  const redirecting = useRef(false);

  const signedOAuth = hasSignedOAuthQuery(location.search);
  const next = safeNextPath(params.get("next"));

  /** After a successful sign-in: stay put if Better Auth is continuing OAuth, else go to `next`. */
  function finish(data: unknown) {
    if (isOAuthRedirect(data)) {
      redirecting.current = true; // the browser is being sent to the client app
      return;
    }
    navigate(next, { replace: true });
  }
  const finishRef = useRef(finish);
  useEffect(() => {
    finishRef.current = finish;
  });

  // Passkey autofill (conditional UI): the email field offers saved passkeys.
  useEffect(() => {
    let cancelled = false;
    const supported =
      typeof window !== "undefined" &&
      typeof window.PublicKeyCredential === "function" &&
      typeof window.PublicKeyCredential.isConditionalMediationAvailable === "function";
    if (!supported) return;
    void (async () => {
      try {
        if (!(await window.PublicKeyCredential.isConditionalMediationAvailable())) return;
        const result = await client.signIn.passkey({ autoFill: true });
        if (!cancelled && result?.data) finishRef.current(result.data);
      } catch {
        // aborted by an explicit sign-in, or the user dismissed the prompt
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [client]);

  function validateEmail(): boolean {
    const value = email.trim();
    if (!value) {
      setEmailError(t("login.emailRequired"));
      return false;
    }
    if (!EMAIL_PATTERN.test(value)) {
      setEmailError(t("login.emailInvalid"));
      return false;
    }
    setEmailError(undefined);
    return true;
  }

  async function signInWithPasskey() {
    setError(undefined);
    setBusy("passkey");
    try {
      const result = await client.signIn.passkey();
      if (result.error) {
        setError(authErrorMessage(result.error, t("login.passkeyFailed")));
        setBusy(null);
        return;
      }
      finish(result.data);
    } catch {
      setError(t("login.passkeyFailed"));
    }
    if (!redirecting.current) setBusy(null);
  }

  async function signInWithPassword(e: FormEvent) {
    e.preventDefault();
    setError(undefined);
    const emailOk = validateEmail();
    const passwordOk = password.length > 0;
    setPasswordError(passwordOk ? undefined : t("login.passwordRequired"));
    if (!emailOk || !passwordOk) return;

    setBusy("password");
    try {
      const result = await client.signIn.email({ email: email.trim(), password });
      if (result.error) {
        setError(
          result.error.code === "INVALID_EMAIL_OR_PASSWORD" || result.error.status === 401
            ? t("login.invalidCredentials")
            : authErrorMessage(result.error, t("login.signInFailed")),
        );
        setBusy(null);
        return;
      }
      finish(result.data);
    } catch {
      setError(t("login.signInFailed"));
    }
    if (!redirecting.current) setBusy(null);
  }

  async function sendMagicLink() {
    setError(undefined);
    if (!validateEmail()) return;
    setBusy("magic");
    try {
      // The link opens a different tab, so the signed OAuth query cannot ride along:
      // resume the authorization request through its plain parameters instead.
      const target = signedOAuth ? oauthResumeUrl(location.search) : next;
      const origin = window.location.origin;
      const result = await client.signIn.magicLink({
        email: email.trim(),
        callbackURL: `${origin}/magic-link/verify?next=${encodeURIComponent(target)}`,
        errorCallbackURL: `${origin}/magic-link/verify`,
      });
      if (result.error) {
        setError(authErrorMessage(result.error, t("login.magicLinkFailed")));
        setBusy(null);
        return;
      }
      navigate("/magic-link/sent", { state: { email: email.trim(), next: target } });
    } catch {
      setError(t("login.magicLinkFailed"));
      setBusy(null);
    }
  }

  // Already signed in and not mid-authorization: nothing to do here.
  if (session && !signedOAuth && !busy) return <Navigate to={next} replace />;

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-1">
        <h1 className="text-2xl font-semibold">{t("login.title")}</h1>
        <p className="text-muted-foreground text-[15px]">
          {t(signedOAuth ? "login.subtitleContinue" : "login.subtitle")}
        </p>
      </div>

      <form onSubmit={signInWithPassword} noValidate className="flex flex-col gap-4">
        <FieldGroup className="gap-4">
          <Field>
            <FieldLabel htmlFor="login-email">{t("login.emailLabel")}</FieldLabel>
            <Input
              id="login-email"
              name="email"
              type="email"
              autoComplete="username webauthn"
              inputMode="email"
              autoCapitalize="none"
              spellCheck={false}
              className="h-11 rounded-lg text-[15px]"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              aria-invalid={emailError ? true : undefined}
              aria-describedby={emailError ? "login-email-error" : undefined}
              autoFocus
            />
            {emailError ? (
              <p id="login-email-error" role="alert" className="text-destructive text-sm">
                {emailError}
              </p>
            ) : null}
          </Field>
        </FieldGroup>

        <LoadingButton
          type="button"
          size="lg"
          className="h-11 rounded-lg text-[15px]"
          onClick={() => void signInWithPasskey()}
          loading={busy === "passkey"}
          disabled={busy !== null}
        >
          <IconFingerprint size={20} stroke={1.75} />
          {t("login.passkey")}
        </LoadingButton>

        <div className="flex items-center gap-3" aria-hidden="true">
          <Separator className="flex-1" />
          <span className="text-muted-foreground text-[13px]">{t("login.or")}</span>
          <Separator className="flex-1" />
        </div>

        <Field>
          <FieldLabel htmlFor="login-password">{t("login.passwordLabel")}</FieldLabel>
          <Input
            id="login-password"
            name="password"
            type="password"
            autoComplete="current-password"
            className="h-11 rounded-lg text-[15px]"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            aria-invalid={passwordError ? true : undefined}
            aria-describedby={passwordError ? "login-password-error" : undefined}
          />
          {passwordError ? (
            <p id="login-password-error" role="alert" className="text-destructive text-sm">
              {passwordError}
            </p>
          ) : null}
        </Field>

        <FormError message={error} />

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

      <div className="flex flex-col items-center gap-1">
        <LoadingButton
          type="button"
          variant="ghost"
          className="rounded-lg"
          onClick={() => void sendMagicLink()}
          loading={busy === "magic"}
          disabled={busy !== null}
        >
          {t("login.magicLink")}
        </LoadingButton>
        <p className="text-muted-foreground text-center text-[13px]">{t("login.magicLinkHint")}</p>
      </div>
    </div>
  );
}
