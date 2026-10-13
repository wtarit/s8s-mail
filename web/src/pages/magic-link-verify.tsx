import { IconAlertCircle, IconLoader2 } from "@tabler/icons-react";
import { useEffect, useRef, useState } from "react";
import { Link, Navigate, useSearchParams } from "react-router";
import { Button } from "@/components/ui/button";
import { getAuthClient, useAuthSession } from "@/lib/auth-client";
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
 * If a raw `?token=` arrives instead, it is redeemed through the client.
 */
export function MagicLinkVerifyPage() {
  const t = useT();
  const [params] = useSearchParams();
  const client = getAuthClient();
  const { data: session, isPending } = useAuthSession();
  const [redeemFailed, setRedeemFailed] = useState(false);
  const redeemed = useRef(false);

  const errorCode = params.get("error");
  const token = params.get("token");
  const next = params.get("next");
  // The only absolute target we follow is our own OAuth authorize URL.
  const resume = next && isOAuthResumeUrl(next) ? next : null;

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
      } catch {
        setRedeemFailed(true);
      }
    })();
  }, [token, errorCode, client]);

  if (errorCode || redeemFailed) {
    const { title, body } = errorKey(errorCode ?? "INVALID_TOKEN");
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

  if (!isPending && !session && !token) {
    // Opened without a session, error or token: nothing to redeem.
    return <Navigate to="/login" replace />;
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
