import {
  aliasListResponse,
  createUserResponse,
  newInviteResponse,
  type AdminUser,
  type Invite,
  type Role,
} from "@s8s/shared";
import { IconTrash } from "@tabler/icons-react";
import { useState, type FormEvent } from "react";
import { toast } from "sonner";
import { FormError } from "@/components/form-error";
import { InviteResult } from "@/components/invite-result";
import { ListSkeleton } from "@/components/list-skeleton";
import { LoadError } from "@/components/load-error";
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
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { api, apiVoid, errorMessage } from "@/lib/api";
import { useResource } from "@/lib/use-resource";
import { useT } from "@/i18n";

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function RoleSelect({
  id,
  value,
  onChange,
}: {
  id: string;
  value: Role;
  onChange: (role: Role) => void;
}) {
  const t = useT();
  return (
    <Select value={value} onValueChange={(v) => onChange(v as Role)}>
      <SelectTrigger id={id} className="w-full">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value="user">{t("role.user")}</SelectItem>
        <SelectItem value="admin">{t("role.admin")}</SelectItem>
      </SelectContent>
    </Select>
  );
}

function Labeled({
  id,
  label,
  hint,
  error,
  children,
}: {
  id: string;
  label: string;
  hint?: string;
  error?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-2">
      <Label htmlFor={id}>{label}</Label>
      {children}
      {error ? (
        <p id={`${id}-error`} role="alert" className="text-destructive text-sm">
          {error}
        </p>
      ) : hint ? (
        <p className="text-muted-foreground text-[13px]">{hint}</p>
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------- new user

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

// ---------------------------------------------------------------- new invite link

export function InviteDialog({ user, onClose }: { user: AdminUser | null; onClose: () => void }) {
  return (
    <Dialog open={user !== null} onOpenChange={(open) => !open && onClose()}>
      <DialogContent>
        {user ? <InviteBody key={user.id} user={user} onClose={onClose} /> : null}
      </DialogContent>
    </Dialog>
  );
}

function InviteBody({ user, onClose }: { user: AdminUser; onClose: () => void }) {
  const t = useT();
  const [invite, setInvite] = useState<Invite>();
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);

  async function generate() {
    setBusy(true);
    setError(undefined);
    try {
      const res = await api(
        `/api/admin/users/${encodeURIComponent(user.id)}/invite`,
        newInviteResponse,
        {
          method: "POST",
        },
      );
      setInvite(res.invite);
    } catch (err) {
      setError(errorMessage(err));
    }
    setBusy(false);
  }

  return (
    <div className="flex flex-col gap-4">
      <DialogHeader>
        <DialogTitle>{t("users.inviteTitle", { name: user.name })}</DialogTitle>
        <DialogDescription>
          {t(invite ? "users.inviteReady" : "users.inviteBody")}
        </DialogDescription>
      </DialogHeader>
      {invite ? <InviteResult invite={invite} name={user.name} /> : null}
      <FormError message={error} />
      <DialogFooter>
        {invite ? (
          <Button onClick={onClose}>{t("common.done")}</Button>
        ) : (
          <>
            <Button type="button" variant="outline" onClick={onClose}>
              {t("common.cancel")}
            </Button>
            <LoadingButton loading={busy} onClick={() => void generate()}>
              {t("users.inviteGenerate")}
            </LoadingButton>
          </>
        )}
      </DialogFooter>
    </div>
  );
}

// ---------------------------------------------------------------- edit

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

// ---------------------------------------------------------------- aliases

export function AliasesDialog({
  user,
  onClose,
  onChanged,
}: {
  user: AdminUser | null;
  onClose: () => void;
  onChanged: () => Promise<void>;
}) {
  return (
    <Dialog open={user !== null} onOpenChange={(open) => !open && onClose()}>
      <DialogContent>
        {user ? (
          <AliasesBody key={user.id} user={user} onClose={onClose} onChanged={onChanged} />
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

function AliasesBody({
  user,
  onClose,
  onChanged,
}: {
  user: AdminUser;
  onClose: () => void;
  onChanged: () => Promise<void>;
}) {
  const t = useT();
  const path = `/api/admin/users/${encodeURIComponent(user.id)}/aliases`;
  const { data, loading, error, reload } = useResource(() => api(path, aliasListResponse));
  const [address, setAddress] = useState("");
  const [addError, setAddError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [removing, setRemoving] = useState<string>();

  async function add(e: FormEvent) {
    e.preventDefault();
    if (!EMAIL_PATTERN.test(address.trim())) {
      setAddError(t("users.aliasInvalid"));
      return;
    }
    setBusy(true);
    setAddError(undefined);
    try {
      await apiVoid(path, { method: "POST", body: { address: address.trim() } });
      setAddress("");
      await reload();
      await onChanged();
      toast.success(t("users.aliasAdded"));
    } catch (err) {
      setAddError(errorMessage(err));
    }
    setBusy(false);
  }

  async function remove(alias: string) {
    setRemoving(alias);
    setAddError(undefined);
    try {
      await apiVoid(`${path}/${encodeURIComponent(alias)}`, { method: "DELETE" });
      await reload();
      await onChanged();
      toast.success(t("users.aliasRemoved"));
    } catch (err) {
      setAddError(errorMessage(err));
    }
    setRemoving(undefined);
  }

  return (
    <div className="flex flex-col gap-4">
      <DialogHeader>
        <DialogTitle>{t("users.aliasesTitle", { name: user.name })}</DialogTitle>
        <DialogDescription>{t("users.aliasesBody", { email: user.email })}</DialogDescription>
      </DialogHeader>

      {loading ? <ListSkeleton rows={2} /> : null}
      {error && !data ? <LoadError message={error} onRetry={() => void reload()} /> : null}
      {data && data.aliases.length === 0 ? (
        <p className="text-muted-foreground text-sm">{t("users.aliasesEmpty")}</p>
      ) : null}
      {data && data.aliases.length > 0 ? (
        <ul className="divide-border border-border divide-y rounded-lg border">
          {data.aliases.map((a) => (
            <li key={a.address} className="flex items-center justify-between gap-2 px-3 py-2">
              <span className="min-w-0 truncate font-mono text-[13px]">{a.address}</span>
              <Button
                variant="ghost"
                size="icon"
                aria-label={t("users.aliasRemoveAria", { address: a.address })}
                disabled={removing === a.address}
                onClick={() => void remove(a.address)}
              >
                <IconTrash size={18} stroke={1.75} />
              </Button>
            </li>
          ))}
        </ul>
      ) : null}

      <form onSubmit={add} noValidate className="flex flex-col gap-2">
        <Labeled
          id="alias-address"
          label={t("users.aliasAdd")}
          error={addError}
          hint={t("users.aliasHint")}
        >
          <div className="flex gap-2">
            <Input
              id="alias-address"
              type="email"
              value={address}
              onChange={(e) => setAddress(e.target.value)}
              aria-invalid={addError ? true : undefined}
              aria-describedby={addError ? "alias-address-error" : undefined}
            />
            <LoadingButton type="submit" variant="outline" loading={busy} className="shrink-0">
              {t("users.aliasAddSubmit")}
            </LoadingButton>
          </div>
        </Labeled>
      </form>

      <DialogFooter>
        <Button onClick={onClose}>{t("common.done")}</Button>
      </DialogFooter>
    </div>
  );
}
