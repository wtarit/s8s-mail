import { useState, type FormEvent } from "react";
import { FormError } from "@/components/form-error";
import { LoadingButton } from "@/components/loading-button";
import { Field, FieldDescription, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { apiVoid, errorMessage } from "@/lib/api";
import { useT } from "@/i18n";

export const MIN_PASSWORD_LENGTH = 10;

interface PasswordFormProps {
  /** Ask for the current password first (the account already has one). */
  requireCurrent: boolean;
  submitLabel: string;
  onDone: () => void | Promise<void>;
  /** Auth pages use taller controls (design-system.md section 2). */
  large?: boolean;
  variant?: "default" | "outline";
}

/** Set or change the password through `POST /api/account/password`. */
export function PasswordForm({
  requireCurrent,
  submitLabel,
  onDone,
  large,
  variant = "default",
}: PasswordFormProps) {
  const t = useT();
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [confirm, setConfirm] = useState("");
  const [errors, setErrors] = useState<{ current?: string; next?: string; confirm?: string }>({});
  const [formError, setFormError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const inputClass = large ? "h-11 rounded-lg text-[15px]" : undefined;

  async function submit(e: FormEvent) {
    e.preventDefault();
    const found: typeof errors = {};
    if (requireCurrent && !current) found.current = t("password.currentRequired");
    if (next.length < MIN_PASSWORD_LENGTH) {
      found.next = t("password.tooShort", { min: MIN_PASSWORD_LENGTH });
    }
    if (confirm !== next) found.confirm = t("password.mismatch");
    setErrors(found);
    setFormError(undefined);
    if (Object.keys(found).length > 0) return;

    setBusy(true);
    try {
      await apiVoid("/api/account/password", {
        method: "POST",
        body: { newPassword: next, ...(requireCurrent ? { currentPassword: current } : {}) },
      });
      setCurrent("");
      setNext("");
      setConfirm("");
      await onDone();
    } catch (err) {
      setFormError(errorMessage(err));
    }
    setBusy(false);
  }

  return (
    <form onSubmit={submit} noValidate className="flex flex-col gap-4">
      <FieldGroup className="gap-4">
        {requireCurrent ? (
          <Field>
            <FieldLabel htmlFor="pw-current">{t("password.current")}</FieldLabel>
            <Input
              id="pw-current"
              type="password"
              autoComplete="current-password"
              className={inputClass}
              value={current}
              onChange={(e) => setCurrent(e.target.value)}
              aria-invalid={errors.current ? true : undefined}
              aria-describedby={errors.current ? "pw-current-error" : undefined}
            />
            {errors.current ? (
              <p id="pw-current-error" role="alert" className="text-destructive text-sm">
                {errors.current}
              </p>
            ) : null}
          </Field>
        ) : null}
        <Field>
          <FieldLabel htmlFor="pw-new">{t("password.new")}</FieldLabel>
          <Input
            id="pw-new"
            type="password"
            autoComplete="new-password"
            className={inputClass}
            value={next}
            onChange={(e) => setNext(e.target.value)}
            aria-invalid={errors.next ? true : undefined}
            aria-describedby="pw-new-hint"
          />
          <FieldDescription id="pw-new-hint">
            {errors.next ? (
              <span role="alert" className="text-destructive">
                {errors.next}
              </span>
            ) : (
              t("password.hint", { min: MIN_PASSWORD_LENGTH })
            )}
          </FieldDescription>
        </Field>
        <Field>
          <FieldLabel htmlFor="pw-confirm">{t("password.confirm")}</FieldLabel>
          <Input
            id="pw-confirm"
            type="password"
            autoComplete="new-password"
            className={inputClass}
            value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
            aria-invalid={errors.confirm ? true : undefined}
            aria-describedby={errors.confirm ? "pw-confirm-error" : undefined}
          />
          {errors.confirm ? (
            <p id="pw-confirm-error" role="alert" className="text-destructive text-sm">
              {errors.confirm}
            </p>
          ) : null}
        </Field>
      </FieldGroup>
      <FormError message={formError} />
      <div>
        <LoadingButton
          type="submit"
          variant={variant}
          size={large ? "lg" : "default"}
          className={large ? "h-11 rounded-lg text-[15px]" : undefined}
          loading={busy}
        >
          {submitLabel}
        </LoadingButton>
      </div>
    </form>
  );
}
