import type { AdminUser, Role } from "#shared";
import { useState, type FormEvent } from "react";
import { toast } from "sonner";
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
import { Input } from "@/components/ui/input";
import { apiVoid, errorMessage } from "@/lib/api";
import { useT } from "@/i18n";
import { EMAIL_PATTERN, Labeled, RoleSelect } from "./user-dialog-parts";

export function EditUserDialog({
  user,
  isSelf,
  onClose,
  onSaved,
}: {
  user: AdminUser | null;
  isSelf: boolean;
  onClose: () => void;
  onSaved: () => Promise<void>;
}) {
  return (
    <Dialog open={user !== null} onOpenChange={(open) => !open && onClose()}>
      <DialogContent>
        {user ? (
          <EditUserForm
            key={user.id}
            user={user}
            isSelf={isSelf}
            onClose={onClose}
            onSaved={onSaved}
          />
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

function EditUserForm({
  user,
  isSelf,
  onClose,
  onSaved,
}: {
  user: AdminUser;
  isSelf: boolean;
  onClose: () => void;
  onSaved: () => Promise<void>;
}) {
  const t = useT();
  const [name, setName] = useState(user.name);
  const [role, setRole] = useState<Role>(user.role);
  const [recovery, setRecovery] = useState(user.recoveryEmail ?? "");
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string>();
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    const found: Record<string, string> = {};
    if (!name.trim()) found.name = t("users.nameRequired");
    if (recovery.trim() && !EMAIL_PATTERN.test(recovery.trim())) {
      found.recovery = t("users.recoveryInvalid");
    }
    setErrors(found);
    setFormError(undefined);
    if (Object.keys(found).length > 0) return;

    const body: Record<string, unknown> = {};
    if (name.trim() !== user.name) body.name = name.trim();
    if (role !== user.role) body.role = role;
    if (recovery.trim() && recovery.trim() !== (user.recoveryEmail ?? "")) {
      body.recoveryEmail = recovery.trim();
    }
    if (Object.keys(body).length === 0) {
      onClose();
      return;
    }
    setBusy(true);
    try {
      await apiVoid(`/api/admin/users/${encodeURIComponent(user.id)}`, { method: "PATCH", body });
      toast.success(t("users.saved"));
      await onSaved();
      onClose();
    } catch (err) {
      setFormError(errorMessage(err));
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} noValidate className="flex flex-col gap-4">
      <DialogHeader>
        <DialogTitle>{t("users.editTitle", { name: user.name })}</DialogTitle>
        <DialogDescription>{user.email}</DialogDescription>
      </DialogHeader>
      <Labeled id="edit-user-name" label={t("users.name")} error={errors.name}>
        <Input
          id="edit-user-name"
          value={name}
          maxLength={100}
          onChange={(e) => setName(e.target.value)}
          aria-invalid={errors.name ? true : undefined}
          aria-describedby={errors.name ? "edit-user-name-error" : undefined}
        />
      </Labeled>
      <Labeled
        id="edit-user-recovery"
        label={t("users.recoveryEmail")}
        hint={t("users.recoveryEmailHint")}
        error={errors.recovery}
      >
        <Input
          id="edit-user-recovery"
          type="email"
          value={recovery}
          onChange={(e) => setRecovery(e.target.value)}
          aria-invalid={errors.recovery ? true : undefined}
          aria-describedby={errors.recovery ? "edit-user-recovery-error" : undefined}
        />
      </Labeled>
      <Labeled
        id="edit-user-role"
        label={t("users.role")}
        hint={isSelf ? t("users.roleSelfHint") : undefined}
      >
        {isSelf ? (
          <Input id="edit-user-role" value={t(`role.${role}`)} readOnly disabled />
        ) : (
          <RoleSelect id="edit-user-role" value={role} onChange={setRole} />
        )}
      </Labeled>
      <FormError message={formError} />
      <DialogFooter>
        <Button type="button" variant="outline" onClick={onClose} disabled={busy}>
          {t("common.cancel")}
        </Button>
        <LoadingButton type="submit" loading={busy}>
          {t("common.save")}
        </LoadingButton>
      </DialogFooter>
    </form>
  );
}
