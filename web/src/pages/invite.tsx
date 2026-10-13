import { inviteAcceptResponse, inviteInfoResponse, type InviteInfoResponse } from "@s8s/shared";
import { IconAlertCircle, IconCircleCheck } from "@tabler/icons-react";
import { useCallback, useEffect, useState } from "react";
import { Link, useParams } from "react-router";
import { toast } from "sonner";
import { AddPasskeyForm } from "@/components/add-passkey-form";
import { Callout } from "@/components/callout";
import { FormError } from "@/components/form-error";
import { LoadError } from "@/components/load-error";
import { LoadingButton } from "@/components/loading-button";
import { PasswordForm } from "@/components/password-form";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { useRuntimeConfig } from "@/config/runtime-config";
import { api, ApiRequestError, errorMessage } from "@/lib/api";
import { minutesUntil } from "@/lib/format";
import { useT } from "@/i18n";

type Phase =
  | { kind: "loading" }
  | { kind: "error"; message: string }
  | { kind: "unavailable"; reason: "expired" | "used" | "invalid" }
  | { kind: "ready"; info: InviteInfoResponse }
  | { kind: "secure"; info: InviteInfoResponse }
  | { kind: "done"; info: InviteInfoResponse };

export function InvitePage() {
  const t = useT();
  const { token = "" } = useParams();
  const { webmailUrl, appName } = useRuntimeConfig();
  const [phase, setPhase] = useState<Phase>({ kind: "loading" });
  const [accepting, setAccepting] = useState(false);
  const [acceptError, setAcceptError] = useState<string>();
  const [passkeyAdded, setPasskeyAdded] = useState(false);
  const [passwordSet, setPasswordSet] = useState(false);

  const fetchPhase = useCallback(async (): Promise<Phase> => {
    try {
      const info = await api(`/api/invite/${encodeURIComponent(token)}`, inviteInfoResponse);
      return info.status === "valid"
        ? { kind: "ready", info }
        : { kind: "unavailable", reason: info.status };
    } catch (e) {
      if (e instanceof ApiRequestError && (e.status === 404 || e.status === 410)) {
        return { kind: "unavailable", reason: "invalid" };
      }
      return { kind: "error", message: errorMessage(e) };
    }
  }, [token]);

  useEffect(() => {
    let cancelled = false;
    void fetchPhase().then((next) => {
      if (!cancelled) setPhase(next);
    });
    return () => {
      cancelled = true;
    };
  }, [fetchPhase]);

  function retry() {
    setPhase({ kind: "loading" });
    void fetchPhase().then(setPhase);
  }

  async function accept(info: InviteInfoResponse) {
    setAccepting(true);
    setAcceptError(undefined);
    try {
      await api(`/api/invite/${encodeURIComponent(token)}/accept`, inviteAcceptResponse, {
        method: "POST",
      });
      setPhase({ kind: "secure", info });
    } catch (e) {
      if (
        e instanceof ApiRequestError &&
        (e.status === 404 || e.status === 410 || e.status === 409)
      ) {
        setPhase({ kind: "unavailable", reason: e.status === 409 ? "used" : "invalid" });
      } else {
        setAcceptError(errorMessage(e));
      }
    }
    setAccepting(false);
  }

  if (phase.kind === "loading") {
    return (
      <div className="flex flex-col gap-4" role="status" aria-label={t("app.loading")}>
        <Skeleton className="h-8 w-2/3" />
        <Skeleton className="h-16 w-full" />
        <Skeleton className="h-11 w-full" />
      </div>
    );
  }

  if (phase.kind === "error") {
    return (
      <div className="flex flex-col gap-4">
        <h1 className="text-2xl font-semibold">{t("invite.title")}</h1>
        <LoadError message={phase.message} onRetry={retry} />
      </div>
    );
  }

  if (phase.kind === "unavailable") {
    return (
      <div className="flex flex-col gap-6">
        <div className="flex flex-col items-start gap-3">
          <IconAlertCircle size={32} stroke={1.5} className="text-destructive" aria-hidden="true" />
          <h1 className="text-2xl font-semibold">{t(`invite.${phase.reason}Title`)}</h1>
          <p className="text-muted-foreground text-[15px]">{t(`invite.${phase.reason}Body`)}</p>
        </div>
        <Button asChild variant="outline" size="lg" className="h-11 rounded-lg text-[15px]">
          <Link to="/login">{t("invite.toLogin")}</Link>
        </Button>
      </div>
    );
  }

  const { info } = phase;

  if (phase.kind === "ready") {
    const minutes = minutesUntil(info.expiresAt);
    return (
      <div className="flex flex-col gap-6">
        <div className="flex flex-col gap-2">
          <h1 className="text-2xl font-semibold">{t("invite.welcome", { name: info.name })}</h1>
          <p className="text-muted-foreground text-[15px]">{t("invite.intro", { appName })}</p>
        </div>
        <div className="bg-muted rounded-lg px-4 py-3">
          <p className="text-muted-foreground text-[13px]">{t("invite.accountEmail")}</p>
          <p className="font-mono text-[15px] break-all">{info.email}</p>
        </div>
        {minutes > 0 && minutes <= 60 ? (
          <Callout tone="warning">{t("invite.expiresSoon", { minutes })}</Callout>
        ) : null}
        <FormError message={acceptError} />
        <LoadingButton
          size="lg"
          className="h-11 rounded-lg text-[15px]"
          loading={accepting}
          onClick={() => void accept(info)}
        >
          {t("invite.accept")}
        </LoadingButton>
      </div>
    );
  }

  if (phase.kind === "done") {
    return (
      <div className="flex flex-col gap-6">
        <div className="flex flex-col items-start gap-3">
          <IconCircleCheck size={32} stroke={1.5} className="text-success" aria-hidden="true" />
          <h1 className="text-2xl font-semibold">{t("invite.doneTitle")}</h1>
          <p className="text-muted-foreground text-[15px]">
            {t(passkeyAdded || passwordSet ? "invite.doneBody" : "invite.doneSkipped")}
          </p>
        </div>
        <div className="flex flex-col gap-2">
          {webmailUrl ? (
            <Button asChild size="lg" className="h-11 rounded-lg text-[15px]">
              <a href={webmailUrl}>{t("invite.continueMail")}</a>
            </Button>
          ) : null}
          <Button
            asChild
            variant={webmailUrl ? "outline" : "default"}
            size="lg"
            className="h-11 rounded-lg text-[15px]"
          >
            <Link to="/account/profile">{t("invite.goAccount")}</Link>
          </Button>
        </div>
      </div>
    );
  }

  // phase.kind === "secure": the invite is accepted and we have a session.
  const secured = passkeyAdded || passwordSet;
  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-2">
        <h1 className="text-2xl font-semibold">{t("invite.secureTitle")}</h1>
        <p className="text-muted-foreground text-[15px]">{t("invite.secureBody")}</p>
      </div>

      <section className="flex flex-col gap-3" aria-labelledby="invite-passkey-heading">
        <h2 id="invite-passkey-heading" className="text-base font-semibold">
          {t("invite.passkeyHeading")}
        </h2>
        {passkeyAdded ? (
          <Callout tone="success">{t("invite.passkeyAdded")}</Callout>
        ) : (
          <AddPasskeyForm
            large
            onAdded={() => {
              setPasskeyAdded(true);
              toast.success(t("passkeys.added"));
            }}
          />
        )}
      </section>

      <section className="flex flex-col gap-3" aria-labelledby="invite-password-heading">
        <h2 id="invite-password-heading" className="text-base font-semibold">
          {t("invite.passwordHeading")}
        </h2>
        {passwordSet ? (
          <Callout tone="success">{t("invite.passwordSet")}</Callout>
        ) : (
          <PasswordForm
            large
            variant="outline"
            requireCurrent={false}
            submitLabel={t("password.set")}
            onDone={() => {
              setPasswordSet(true);
              toast.success(t("password.saved"));
            }}
          />
        )}
      </section>

      <Button
        variant={secured ? "outline" : "ghost"}
        size="lg"
        className="h-11 rounded-lg text-[15px]"
        onClick={() => setPhase({ kind: "done", info })}
      >
        {t(secured ? "invite.finish" : "invite.skip")}
      </Button>
    </div>
  );
}
