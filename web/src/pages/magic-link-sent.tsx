import { IconMailCheck } from "@tabler/icons-react";
import { useEffect, useState } from "react";
import { Link, useLocation } from "react-router";
import { Callout } from "@/components/callout";
import { FormError } from "@/components/form-error";
import { LoadingButton } from "@/components/loading-button";
import { Button } from "@/components/ui/button";
import { authErrorMessage, getAuthClient } from "@/lib/auth-client";
import { toast } from "sonner";
import { useT } from "@/i18n";

const RESEND_COOLDOWN_SECONDS = 30;
export const MAGIC_LINK_EXPIRY_MINUTES = 15;

interface SentState {
  email?: string;
  next?: string;
}

export function MagicLinkSentPage() {
  const t = useT();
  const state = (useLocation().state ?? {}) as SentState;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  // Resend is rate limited client-side; the deadline is compared with the clock each second.
  const [resendAt, setResendAt] = useState(() => Date.now() + RESEND_COOLDOWN_SECONDS * 1000);
  const [now, setNow] = useState(() => Date.now());
  const cooldown = Math.max(0, Math.ceil((resendAt - now) / 1000));

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);

  async function resend() {
    if (!state.email) return;
    setBusy(true);
    setError(undefined);
    try {
      const origin = window.location.origin;
      const result = await getAuthClient().signIn.magicLink({
        email: state.email,
        callbackURL: `${origin}/magic-link/verify?next=${encodeURIComponent(state.next ?? "/account/profile")}`,
        errorCallbackURL: `${origin}/magic-link/verify`,
      });
      if (result.error) {
        setError(authErrorMessage(result.error, t("login.magicLinkFailed")));
      } else {
        toast.success(t("magicLinkSent.resent"));
        setResendAt(Date.now() + RESEND_COOLDOWN_SECONDS * 1000);
        setNow(Date.now());
      }
    } catch {
      setError(t("login.magicLinkFailed"));
    }
    setBusy(false);
  }

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col items-start gap-3">
        <IconMailCheck size={32} stroke={1.5} className="text-primary" aria-hidden="true" />
        <h1 className="text-2xl font-semibold">{t("magicLinkSent.title")}</h1>
        <p className="text-[15px]">{t("magicLinkSent.body")}</p>
        <p className="text-muted-foreground text-[15px]">
          {t("magicLinkSent.expiry", { minutes: MAGIC_LINK_EXPIRY_MINUTES })}
        </p>
      </div>

      <Callout tone="info">{t("magicLinkSent.notMailbox")}</Callout>

      <FormError message={error} />

      <div className="flex flex-col gap-2">
        {state.email ? (
          <LoadingButton
            variant="outline"
            size="lg"
            className="h-11 rounded-lg text-[15px]"
            onClick={() => void resend()}
            loading={busy}
            disabled={cooldown > 0}
          >
            {cooldown > 0
              ? t("magicLinkSent.resendIn", { seconds: cooldown })
              : t("magicLinkSent.resend")}
          </LoadingButton>
        ) : null}
        <Button asChild variant="ghost" className="rounded-lg">
          <Link to="/login">{t("magicLinkSent.back")}</Link>
        </Button>
      </div>
    </div>
  );
}
