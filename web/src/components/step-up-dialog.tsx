import { IconFingerprint } from "@tabler/icons-react";
import { useState, type FormEvent } from "react";
import { Callout } from "@/components/callout";
import { FormError } from "@/components/form-error";
import { LoadingButton } from "@/components/loading-button";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Field, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Separator } from "@/components/ui/separator";
import { ApiRequestError, unwrapAuth } from "@/lib/api";
import { getAuthClient } from "@/lib/auth-client";
import { pendingFactors, type StepUpRequirement } from "@/lib/step-up";
import { useT } from "@/i18n";
import type { FactorName } from "#shared";

interface StepUpDialogProps {
  requirement: StepUpRequirement;
  /** Factors the action proves itself; never asked for here. */
  provides: readonly FactorName[];
  /** Newest requirement from `/api/me`. */
  refresh: () => Promise<StepUpRequirement>;
  onDone: () => void;
  onCancel: () => void;
}

/** Asks only for the factors that are stale in this session. Nothing here starts a new session. */
export function StepUpDialog({
  requirement,
  provides,
  refresh,
  onDone,
  onCancel,
}: StepUpDialogProps) {
  const t = useT();
  const [current, setCurrent] = useState(requirement);
  const [verified, setVerified] = useState<FactorName[]>([]);
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState<FactorName | null>(null);
  const [error, setError] = useState<string>();
  const pending = pendingFactors(current, provides);
  const both = pending.length > 1;

  async function verify(factor: FactorName, proof: () => Promise<unknown>) {
    setBusy(factor);
    setError(undefined);
    try {
      await proof();
    } catch (err) {
      setError(err instanceof Error ? err.message : t("error.generic"));
      setBusy(null);
      return;
    }
    try {
      const next = await refresh();
      setVerified((v) => [...v, factor]);
      setPassword("");
      setCurrent(next);
      if (pendingFactors(next, provides).length === 0) {
        onDone();
        return;
      }
    } catch {
      setError(t("error.network"));
    }
    setBusy(null);
  }

  function verifyPassword(e: FormEvent) {
    e.preventDefault();
    if (!password) {
      setError(t("stepUp.passwordRequired"));
      return;
    }
    void verify("password", async () => {
      try {
        await unwrapAuth(getAuthClient().opaque.stepUp({ password }));
      } catch (err) {
        const wrong = err instanceof ApiRequestError && err.code === "INVALID_EMAIL_OR_PASSWORD";
        throw wrong ? new Error(t("stepUp.wrongPassword")) : err;
      }
    });
  }

  async function proveWithPasskey() {
    try {
      await unwrapAuth(getAuthClient().signIn.passkey());
    } catch {
      throw new Error(t("stepUp.passkeyFailed"));
    }
  }

  return (
    <Dialog open onOpenChange={(open) => !open && !busy && onCancel()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t("stepUp.title")}</DialogTitle>
          <DialogDescription>
            {t(both && current.oneOf ? "stepUp.bodyOne" : "stepUp.body")}
          </DialogDescription>
        </DialogHeader>
        {verified.map((factor) => (
          <Callout key={factor} tone="success">
            {t(factor === "password" ? "stepUp.passwordVerified" : "stepUp.passkeyVerified")}
          </Callout>
        ))}
        {pending.includes("passkey") ? (
          <LoadingButton
            type="button"
            loading={busy === "passkey"}
            disabled={busy !== null}
            onClick={() => void verify("passkey", proveWithPasskey)}
          >
            <IconFingerprint size={18} stroke={1.75} />
            {t("stepUp.verifyPasskey")}
          </LoadingButton>
        ) : null}
        {both ? (
          <div className="flex items-center gap-3" aria-hidden="true">
            <Separator className="flex-1" />
            <span className="text-muted-foreground text-[13px]">{t("login.or")}</span>
            <Separator className="flex-1" />
          </div>
        ) : null}
        {pending.includes("password") ? (
          <form onSubmit={verifyPassword} noValidate className="flex flex-col gap-3">
            <Field>
              <FieldLabel htmlFor="step-up-password">{t("stepUp.password")}</FieldLabel>
              <Input
                id="step-up-password"
                type="password"
                autoComplete="current-password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
              />
            </Field>
            <LoadingButton type="submit" loading={busy === "password"} disabled={busy !== null}>
              {t("stepUp.verifyPassword")}
            </LoadingButton>
          </form>
        ) : null}
        <FormError message={error} />
        <DialogFooter>
          <Button type="button" variant="outline" disabled={busy !== null} onClick={onCancel}>
            {t("common.cancel")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
