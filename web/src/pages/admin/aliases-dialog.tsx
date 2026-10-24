import { aliasListResponse, type AdminUser } from "@s8s/shared";
import { IconTrash } from "@tabler/icons-react";
import { useState, type FormEvent } from "react";
import { toast } from "sonner";
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
import { api, apiVoid, errorMessage } from "@/lib/api";
import { useResource } from "@/lib/use-resource";
import { useT } from "@/i18n";
import { EMAIL_PATTERN, Labeled } from "./user-dialog-parts";

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
