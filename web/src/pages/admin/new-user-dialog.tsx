import { createUserResponse, type Invite, type Role } from "@s8s/shared";
import { useState, type FormEvent } from "react";
import { FormError } from "@/components/form-error";
import { InviteResult } from "@/components/invite-result";
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
import { Input } from "@/components/ui/input";
import { api, errorMessage } from "@/lib/api";
import { useT } from "@/i18n";
import { EMAIL_PATTERN, Labeled, RoleSelect } from "./user-dialog-parts";

export function NewUserDialog({
  open,
  onOpenChange,
  onCreated,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreated: () => Promise<void>;
}) {
  const t = useT();
  const [name, setName] = useState("");
  const [address, setAddress] = useState("");
  const [recovery, setRecovery] = useState("");
  const [role, setRole] = useState<Role>("user");
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ name: string; invite: Invite }>();

  function close(next: boolean) {
    onOpenChange(next);
    if (!next) {
      setName("");
      setAddress("");
      setRecovery("");
      setRole("user");
      setErrors({});
      setFormError(undefined);
      setResult(undefined);
    }
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    const found: Record<string, string> = {};
    if (!name.trim()) found.name = t("users.nameRequired");
    if (!EMAIL_PATTERN.test(address.trim())) found.address = t("users.addressInvalid");
    if (!EMAIL_PATTERN.test(recovery.trim())) found.recovery = t("users.recoveryInvalid");
    setErrors(found);
    setFormError(undefined);
    if (Object.keys(found).length > 0) return;

    setBusy(true);
    try {
      const created = await api("/api/admin/users", createUserResponse, {
        method: "POST",
        body: {
          name: name.trim(),
          primaryAddress: address.trim(),
          recoveryEmail: recovery.trim(),
          role,
        },
      });
      setResult({ name: created.user.name, invite: created.invite });
      await onCreated();
    } catch (err) {
      setFormError(errorMessage(err));
    }
    setBusy(false);
  }

  return (
    <Dialog open={open} onOpenChange={close}>
      <DialogContent>
        {result ? (
          <div className="flex flex-col gap-4">
            <DialogHeader>
              <DialogTitle>{t("users.createdTitle", { name: result.name })}</DialogTitle>
              <DialogDescription>{t("users.createdBody")}</DialogDescription>
            </DialogHeader>
            <InviteResult invite={result.invite} name={result.name} />
            <DialogFooter>
              <Button onClick={() => close(false)}>{t("common.done")}</Button>
            </DialogFooter>
          </div>
        ) : (
          <form onSubmit={submit} noValidate className="flex flex-col gap-4">
            <DialogHeader>
              <DialogTitle>{t("users.newTitle")}</DialogTitle>
              <DialogDescription>{t("users.newBody")}</DialogDescription>
            </DialogHeader>
            <Labeled id="new-user-name" label={t("users.name")} error={errors.name}>
              <Input
                id="new-user-name"
                value={name}
                maxLength={100}
                autoComplete="off"
                onChange={(e) => setName(e.target.value)}
                aria-invalid={errors.name ? true : undefined}
                aria-describedby={errors.name ? "new-user-name-error" : undefined}
                autoFocus
              />
            </Labeled>
            <Labeled
              id="new-user-address"
              label={t("users.primaryAddress")}
              hint={t("users.primaryAddressHint")}
              error={errors.address}
            >
              <Input
                id="new-user-address"
                type="email"
                value={address}
                autoComplete="off"
                onChange={(e) => setAddress(e.target.value)}
                aria-invalid={errors.address ? true : undefined}
                aria-describedby={errors.address ? "new-user-address-error" : undefined}
              />
            </Labeled>
            <Labeled
              id="new-user-recovery"
              label={t("users.recoveryEmail")}
              hint={t("users.recoveryEmailHint")}
              error={errors.recovery}
            >
              <Input
                id="new-user-recovery"
                type="email"
                value={recovery}
                autoComplete="off"
                onChange={(e) => setRecovery(e.target.value)}
                aria-invalid={errors.recovery ? true : undefined}
                aria-describedby={errors.recovery ? "new-user-recovery-error" : undefined}
              />
            </Labeled>
            <Labeled id="new-user-role" label={t("users.role")}>
              <RoleSelect id="new-user-role" value={role} onChange={setRole} />
            </Labeled>
            <FormError message={formError} />
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => close(false)}>
                {t("common.cancel")}
              </Button>
              <LoadingButton type="submit" loading={busy}>
                {t("users.createSubmit")}
              </LoadingButton>
            </DialogFooter>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}
