import { IconDeviceMobile, IconFingerprint, IconPencil, IconTrash } from "@tabler/icons-react";
import { useState, type FormEvent } from "react";
import { ConfirmDialog } from "@/components/confirm-dialog";
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
import { Label } from "@/components/ui/label";
import { errorMessage } from "@/lib/api";
import { formatDate } from "@/lib/format";
import { useT } from "@/i18n";

export interface PasskeyItem {
  id: string;
  name?: string | null;
  createdAt: Date | string;
  /** "singleDevice" or "multiDevice" (synced) as reported by the authenticator. */
  deviceType?: string | null;
  /** Not stored by Better Auth today; shown only when the server provides it. */
  lastUsedAt?: Date | string | null;
}

interface PasskeyListProps {
  passkeys: PasskeyItem[];
  onRename: (id: string, name: string) => Promise<void>;
  onRemove: (id: string) => Promise<void>;
}

/** Passkeys with name, created (and last-used when known) dates, rename and remove. */
export function PasskeyList({ passkeys, onRename, onRemove }: PasskeyListProps) {
  const t = useT();
  const [renaming, setRenaming] = useState<PasskeyItem | null>(null);
  const [removing, setRemoving] = useState<PasskeyItem | null>(null);
  const label = (p: PasskeyItem) => p.name?.trim() || t("passkeys.unnamed");

  return (
    <>
      <ul className="divide-border border-border divide-y rounded-xl border">
        {passkeys.map((passkey) => (
          <li key={passkey.id} className="flex items-center gap-3 p-3">
            {passkey.deviceType === "multiDevice" ? (
              <IconDeviceMobile
                size={20}
                stroke={1.75}
                className="text-muted-foreground shrink-0"
              />
            ) : (
              <IconFingerprint size={20} stroke={1.75} className="text-muted-foreground shrink-0" />
            )}
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-medium">{label(passkey)}</p>
              <p className="text-muted-foreground text-[13px]">
                {t("passkeys.created", { date: formatDate(passkey.createdAt) })}
                {passkey.lastUsedAt
                  ? ` · ${t("passkeys.lastUsed", { date: formatDate(passkey.lastUsedAt) })}`
                  : ""}
              </p>
            </div>
            <Button
              variant="ghost"
              size="icon"
              aria-label={t("passkeys.renameAria", { name: label(passkey) })}
              onClick={() => setRenaming(passkey)}
            >
              <IconPencil size={18} stroke={1.75} />
            </Button>
            <Button
              variant="ghost"
              size="icon"
              aria-label={t("passkeys.removeAria", { name: label(passkey) })}
              onClick={() => setRemoving(passkey)}
            >
              <IconTrash size={18} stroke={1.75} />
            </Button>
          </li>
        ))}
      </ul>

      <RenameDialog
        passkey={renaming}
        onClose={() => setRenaming(null)}
        onRename={onRename}
        initialName={renaming ? (renaming.name ?? "") : ""}
      />

      <ConfirmDialog
        open={removing !== null}
        onOpenChange={(open) => !open && setRemoving(null)}
        title={t("passkeys.removeTitle", { name: removing ? label(removing) : "" })}
        description={t("passkeys.removeBody")}
        confirmLabel={t("passkeys.remove")}
        onConfirm={async () => {
          if (removing) await onRemove(removing.id);
        }}
      />
    </>
  );
}

function RenameDialog({
  passkey,
  initialName,
  onClose,
  onRename,
}: {
  passkey: PasskeyItem | null;
  initialName: string;
  onClose: () => void;
  onRename: (id: string, name: string) => Promise<void>;
}) {
  const t = useT();
  return (
    <Dialog open={passkey !== null} onOpenChange={(open) => !open && onClose()}>
      <DialogContent>
        {passkey ? (
          <RenameForm
            key={passkey.id}
            initialName={initialName}
            onCancel={onClose}
            onSubmit={async (name) => {
              await onRename(passkey.id, name);
              onClose();
            }}
            title={t("passkeys.renameTitle")}
          />
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

function RenameForm({
  initialName,
  title,
  onCancel,
  onSubmit,
}: {
  initialName: string;
  title: string;
  onCancel: () => void;
  onSubmit: (name: string) => Promise<void>;
}) {
  const t = useT();
  const [name, setName] = useState(initialName);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!name.trim()) {
      setError(t("passkeys.nameRequired"));
      return;
    }
    setBusy(true);
    setError(undefined);
    try {
      await onSubmit(name.trim());
    } catch (err) {
      setError(errorMessage(err));
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} className="flex flex-col gap-4" noValidate>
      <DialogHeader>
        <DialogTitle>{title}</DialogTitle>
        <DialogDescription>{t("passkeys.renameBody")}</DialogDescription>
      </DialogHeader>
      <div className="flex flex-col gap-2">
        <Label htmlFor="passkey-rename">{t("passkeys.nameLabel")}</Label>
        <Input
          id="passkey-rename"
          value={name}
          maxLength={100}
          onChange={(e) => setName(e.target.value)}
          aria-invalid={error ? true : undefined}
          autoFocus
        />
      </div>
      <FormError message={error} />
      <DialogFooter>
        <Button type="button" variant="outline" onClick={onCancel} disabled={busy}>
          {t("common.cancel")}
        </Button>
        <LoadingButton type="submit" loading={busy}>
          {t("common.save")}
        </LoadingButton>
      </DialogFooter>
    </form>
  );
}
