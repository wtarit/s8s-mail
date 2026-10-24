import { IconKey, IconPlus, IconTrash } from "@tabler/icons-react";
import { useState, type FormEvent } from "react";
import { toast } from "sonner";
import { Callout } from "@/components/callout";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { CopyField } from "@/components/copy-field";
import { EmptyState } from "@/components/empty-state";
import { FormError } from "@/components/form-error";
import { ListSkeleton } from "@/components/list-skeleton";
import { LoadError } from "@/components/load-error";
import { LoadingButton } from "@/components/loading-button";
import { useStepUp } from "@/components/step-up";
import { PageHeader } from "@/components/page-header";
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
import { unwrapAuth } from "@/lib/api";
import { getAuthClient } from "@/lib/auth-client";
import { formatDate, formatDateTime } from "@/lib/format";
import { isStepUpCancelled } from "@/lib/step-up";
import { useMe } from "@/lib/me";
import { useResource } from "@/lib/use-resource";
import { useT } from "@/i18n";

interface AppPassword {
  id: string;
  name: string;
  createdAt: Date | string;
  lastUsedAt: Date | string | null;
}

async function loadAppPasswords(): Promise<AppPassword[]> {
  const data = await unwrapAuth(getAuthClient().apiKey.list());
  // Better Auth returns `{ apiKeys: [...] }`; tolerate a bare array from older servers.
  const keys = Array.isArray(data) ? data : ((data as { apiKeys?: unknown[] }).apiKeys ?? []);
  return (keys as Array<Record<string, unknown>>).map((k) => ({
    id: String(k.id),
    name: typeof k.name === "string" && k.name ? k.name : "",
    createdAt: k.createdAt as Date | string,
    lastUsedAt: (k.lastRequest as Date | string | null | undefined) ?? null,
  }));
}

export function AppPasswordsPage() {
  const t = useT();
  const { me } = useMe();
  const { data, loading, error, reload } = useResource(loadAppPasswords);
  const [creating, setCreating] = useState(false);
  const [revoking, setRevoking] = useState<AppPassword | null>(null);

  const createButton = (
    <Button onClick={() => setCreating(true)}>
      <IconPlus size={18} stroke={1.75} />
      {t("appPasswords.create")}
    </Button>
  );
  const label = (k: AppPassword) => k.name || t("appPasswords.unnamed");

  return (
    <>
      <PageHeader
        title={t("appPasswords.title")}
        description={t("appPasswords.description", { email: me.user.email })}
        action={data && data.length > 0 ? createButton : undefined}
      />

      {loading ? <ListSkeleton /> : null}
      {error && !data ? <LoadError message={error} onRetry={() => void reload()} /> : null}
      {data && data.length === 0 ? (
        <EmptyState icon={IconKey} message={t("appPasswords.empty")} action={createButton} />
      ) : null}
      {data && data.length > 0 ? (
        <ul className="divide-border border-border divide-y rounded-xl border">
          {data.map((key) => (
            <li key={key.id} className="flex items-center gap-3 p-3">
              <IconKey size={20} stroke={1.75} className="text-muted-foreground shrink-0" />
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium">{label(key)}</p>
                <p className="text-muted-foreground text-[13px]">
                  {t("appPasswords.created", { date: formatDate(key.createdAt) })}
                  {" · "}
                  {key.lastUsedAt
                    ? t("appPasswords.lastUsed", { date: formatDateTime(key.lastUsedAt) })
                    : t("appPasswords.neverUsed")}
                </p>
              </div>
              <Button
                variant="ghost"
                size="icon"
                aria-label={t("appPasswords.revokeAria", { name: label(key) })}
                onClick={() => setRevoking(key)}
              >
                <IconTrash size={18} stroke={1.75} />
              </Button>
            </li>
          ))}
        </ul>
      ) : null}

      <CreateDialog
        open={creating}
        onOpenChange={setCreating}
        email={me.user.email}
        onCreated={reload}
      />

      <ConfirmDialog
        open={revoking !== null}
        onOpenChange={(open) => !open && setRevoking(null)}
        title={t("appPasswords.revokeTitle", { name: revoking ? label(revoking) : "" })}
        description={t("appPasswords.revokeBody")}
        confirmLabel={t("appPasswords.revoke")}
        onConfirm={async () => {
          if (!revoking) return;
          await unwrapAuth(getAuthClient().apiKey.delete({ keyId: revoking.id }));
          toast.success(t("appPasswords.revoked"));
          await reload();
        }}
      />
    </>
  );
}

function CreateDialog({
  open,
  onOpenChange,
  email,
  onCreated,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  email: string;
  onCreated: () => Promise<void>;
}) {
  const t = useT();
  const stepUp = useStepUp();
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  // The key only ever lives in this state: it is dropped when the dialog closes.
  const [secret, setSecret] = useState<string>();

  function close(next: boolean) {
    onOpenChange(next);
    if (!next) {
      setSecret(undefined);
      setName("");
      setError(undefined);
    }
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!name.trim()) {
      setError(t("appPasswords.nameRequired"));
      return;
    }
    setBusy(true);
    setError(undefined);
    try {
      const created = await stepUp.run(() =>
        unwrapAuth(getAuthClient().apiKey.create({ name: name.trim() })),
      );
      setSecret(created.key);
      await onCreated();
    } catch (err) {
      if (!isStepUpCancelled(err)) {
        setError(err instanceof Error ? err.message : t("error.generic"));
      }
    }
    setBusy(false);
  }

  return (
    <Dialog open={open} onOpenChange={close}>
      <DialogContent>
        {secret ? (
          <div className="flex flex-col gap-4">
            <DialogHeader>
              <DialogTitle>{t("appPasswords.createdTitle")}</DialogTitle>
              <DialogDescription>{t("appPasswords.createdBody")}</DialogDescription>
            </DialogHeader>
            <CopyField
              label={t("appPasswords.keyLabel")}
              value={secret}
              warning={t("appPasswords.shownOnce")}
              copiedMessage={t("appPasswords.copied")}
            />
            <Callout tone="info">{t("appPasswords.howTo", { email })}</Callout>
            <DialogFooter>
              <Button onClick={() => close(false)}>{t("common.done")}</Button>
            </DialogFooter>
          </div>
        ) : (
          <form onSubmit={submit} noValidate className="flex flex-col gap-4">
            <DialogHeader>
              <DialogTitle>{t("appPasswords.createTitle")}</DialogTitle>
              <DialogDescription>{t("appPasswords.createBody")}</DialogDescription>
            </DialogHeader>
            <div className="flex flex-col gap-2">
              <Label htmlFor="app-password-name">{t("appPasswords.nameLabel")}</Label>
              <Input
                id="app-password-name"
                value={name}
                maxLength={100}
                placeholder={t("appPasswords.namePlaceholder")}
                onChange={(e) => setName(e.target.value)}
                aria-invalid={error ? true : undefined}
                autoFocus
              />
            </div>
            <FormError message={error} />
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => close(false)}>
                {t("common.cancel")}
              </Button>
              <LoadingButton type="submit" loading={busy}>
                {t("appPasswords.createSubmit")}
              </LoadingButton>
            </DialogFooter>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}
