import { IconAlertCircle, IconLoader2 } from "@tabler/icons-react";
import { useEffect, useRef, useState } from "react";
import { Link, Navigate, useNavigate, useSearchParams } from "react-router";
import { SecondFactorStep } from "@/components/second-factor-step";
import { Button } from "@/components/ui/button";
import { getAuthClient, useAuthSession } from "@/lib/auth-client";
import { usePendingSignIn } from "@/lib/pending-sign-in";
import { isOAuthResumeUrl, safeNextPath } from "@/lib/navigation";
import { useT, type MessageKey } from "@/i18n";

/** Better Auth magic-link error codes (as `?error=` on the error callback URL). */
function errorKey(code: string): { title: MessageKey; body: MessageKey } {
  switch (code.toUpperCase()) {
    case "EXPIRED_TOKEN":
      return { title: "magicLinkVerify.expiredTitle", body: "magicLinkVerify.expiredBody" };
    case "ATTEMPTS_EXCEEDED":
      return { title: "magicLinkVerify.usedTitle", body: "magicLinkVerify.usedBody" };
    case "INVALID_TOKEN":
      return { title: "magicLinkVerify.invalidTitle", body: "magicLinkVerify.invalidBody" };
    default:
      return { title: "magicLinkVerify.failedTitle", body: "magicLinkVerify.failedBody" };
  }
}

/**
 * Landing page for the magic-link flow. Better Auth verifies the token server-side and
 * redirects here: with a session cookie on success, or with `?error=CODE` on failure.
 * A 2FA user arrives WITHOUT a session but with a pending-recovery cookie: the link is then only
 * the first half, and the page asks for a passkey or the password (GET /pending-sign-in).
 * If a raw `?token=` arrives instead, it is redeemed through the client.
 */
export function MagicLinkVerifyPage() {
  const t = useT();
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const client = getAuthClient();
  const { data: session, isPending } = useAuthSession();
  const [redeemFailed, setRedeemFailed] = useState(false);
  const [redeemOk, setRedeemOk] = useState(false);
  const redeemed = useRef(false);

  const errorCode = params.get("error");
  const token = params.get("token");
  const next = params.get("next");
  // The only absolute target we follow is our own OAuth authorize URL.
  const resume = next && isOAuthResumeUrl(next) ? next : null;

  // Nobody is signed in yet: a 2FA user may still have a pending second step to finish.
  const lookup = !isPending && !session && (!token || redeemOk) && !errorCode;
  const pendingSignIn = usePendingSignIn(lookup);

  useEffect(() => {
    if (session && resume && !errorCode) window.location.assign(resume);
  }, [session, resume, errorCode]);

  useEffect(() => {
    if (!token || errorCode || redeemed.current) return;
    redeemed.current = true;
    void (async () => {
      try {
        const result = await client.magicLink.verify({ query: { token } });
        if (result.error) setRedeemFailed(true);
        else setRedeemOk(true);
      } catch {
        setRedeemFailed(true);
      }
    })();
  }, [token, errorCode, client]);

  const secondStep = lookup ? pendingSignIn.pending : null;
  const nobodySignedIn = lookup && !pendingSignIn.loading && !secondStep;
  if (errorCode || redeemFailed || nobodySignedIn) {
    // Without a session or a pending second step the link signed nobody in (also: no factors).
    const { title, body } = errorKey(errorCode ?? (redeemFailed ? "INVALID_TOKEN" : "FAILED"));
    return (
      <div className="flex flex-col gap-6">
        <div className="flex flex-col items-start gap-3">
          <IconAlertCircle size={32} stroke={1.5} className="text-destructive" aria-hidden="true" />
          <h1 className="text-2xl font-semibold">{t(title)}</h1>
          <p className="text-muted-foreground text-[15px]">{t(body)}</p>
        </div>
        <Button asChild size="lg" className="h-11 rounded-lg text-[15px]">
          <Link to="/login">{t("magicLinkVerify.backToLogin")}</Link>
        </Button>
      </div>
    );
  }

  if (session && !resume) return <Navigate to={safeNextPath(next)} replace />;

  if (secondStep) {
    const { via, email, factors } = secondStep;
    return (
      <SecondFactorStep
        via={via}
        email={email}
        factors={factors}
        onSignedIn={() => (resume ? window.location.assign(resume) : navigate(safeNextPath(next)))}
      />
    );
  }

  return (
    <div className="flex flex-col gap-4" role="status">
      <h1 className="text-2xl font-semibold">{t("magicLinkVerify.title")}</h1>
      <p className="text-muted-foreground flex items-center gap-2 text-[15px]">
        <IconLoader2 size={18} stroke={1.75} className="animate-spin" aria-hidden="true" />
        {t("magicLinkVerify.body")}
      </p>
    </div>
  );
}
