import {
  createOAuthClientRequest,
  createOAuthClientResponse,
  type oauthClient,
  oauthClientListResponse,
} from "@s8s/shared";
import { IconApps, IconPlus, IconTrash } from "@tabler/icons-react";
import { useState, type FormEvent } from "react";
import { toast } from "sonner";
import type { z } from "zod";
import { Callout } from "@/components/callout";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { CopyField } from "@/components/copy-field";
import { EmptyState } from "@/components/empty-state";
import { FormError } from "@/components/form-error";
import { ListSkeleton } from "@/components/list-skeleton";
import { LoadError } from "@/components/load-error";
import { LoadingButton } from "@/components/loading-button";
import { PageHeader } from "@/components/page-header";
import { Badge } from "@/components/ui/badge";
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
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { api, apiVoid, errorMessage } from "@/lib/api";
import { formatDate } from "@/lib/format";
import { useResource } from "@/lib/use-resource";
import { useT } from "@/i18n";

type Client = z.infer<typeof oauthClient>;

export function ClientsPage() {
  const t = useT();
  const { data, loading, error, reload } = useResource(() =>
    api("/api/admin/oauth-clients", oauthClientListResponse),
  );
  const [creating, setCreating] = useState(false);
  const [removing, setRemoving] = useState<Client | null>(null);
  const clients = data?.clients;

  const createButton = (
    <Button onClick={() => setCreating(true)}>
      <IconPlus size={18} stroke={1.75} />
      {t("clients.create")}
    </Button>
  );

  return (
    <>
      <PageHeader
        title={t("adminClients.title")}
        description={t("clients.description")}
        action={clients && clients.length > 0 ? createButton : undefined}
      />

      {loading ? <ListSkeleton /> : null}
      {error && !data ? <LoadError message={error} onRetry={() => void reload()} /> : null}
      {clients && clients.length === 0 ? (
        <EmptyState icon={IconApps} message={t("clients.empty")} action={createButton} />
      ) : null}

      {clients && clients.length > 0 ? (
        <ul className="divide-border border-border divide-y rounded-xl border">
          {clients.map((client) => (
            <li key={client.clientId} className="flex items-start gap-3 p-3">
              <IconApps size={20} stroke={1.75} className="text-muted-foreground mt-0.5 shrink-0" />
              <div className="min-w-0 flex-1">
                <p className="flex flex-wrap items-center gap-2 text-sm font-medium">
                  <span className="truncate">{client.name}</span>
                  {client.trusted ? (
                    <Badge variant="secondary">{t("clients.trusted")}</Badge>
                  ) : null}
                  <Badge variant="outline">
                    {t(client.public ? "clients.public" : "clients.confidential")}
                  </Badge>
                </p>
                <p className="text-muted-foreground font-mono text-[13px] break-all">
                  {client.clientId}
                </p>
                <ul className="text-muted-foreground mt-1 text-[13px]">
                  {client.redirectUris.map((uri) => (
                    <li key={uri} className="font-mono break-all">
                      {uri}
                    </li>
                  ))}
                </ul>
                <p className="text-muted-foreground mt-1 text-[13px]">
                  {t("clients.created", { date: formatDate(client.createdAt) })}
                </p>
              </div>
              <Button
                variant="ghost"
                size="icon"
                aria-label={t("clients.deleteAria", { name: client.name })}
                onClick={() => setRemoving(client)}
              >
                <IconTrash size={18} stroke={1.75} />
              </Button>
            </li>
          ))}
        </ul>
      ) : null}

      <CreateClientDialog open={creating} onOpenChange={setCreating} onCreated={reload} />

      <ConfirmDialog
        open={removing !== null}
        onOpenChange={(open) => !open && setRemoving(null)}
        title={t("clients.deleteTitle", { name: removing?.name ?? "" })}
        description={t("clients.deleteBody")}
        confirmLabel={t("clients.delete")}
        onConfirm={async () => {
          if (!removing) return;
          await apiVoid(`/api/admin/oauth-clients/${encodeURIComponent(removing.clientId)}`, {
            method: "DELETE",
          });
          toast.success(t("clients.deleted", { name: removing.name }));
          await reload();
        }}
      />
    </>
  );
}

function CreateClientDialog({
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
  const [uris, setUris] = useState("");
  const [trusted, setTrusted] = useState(false);
  const [isPublic, setIsPublic] = useState(true);
  const [errors, setErrors] = useState<{ name?: string; uris?: string }>({});
  const [formError, setFormError] = useState<string>();
  const [busy, setBusy] = useState(false);
  // Client secret lives only in this state; dropped when the dialog closes.
  const [created, setCreated] = useState<z.infer<typeof createOAuthClientResponse>>();

  function close(next: boolean) {
    onOpenChange(next);
    if (!next) {
      setName("");
      setUris("");
      setTrusted(false);
      setIsPublic(true);
      setErrors({});
      setFormError(undefined);
      setCreated(undefined);
    }
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    setFormError(undefined);
    const found: typeof errors = {};
    if (!name.trim()) found.name = t("clients.nameRequired");
    const redirectUris = uris
      .split(/[\s,]+/)
      .map((u) => u.trim())
      .filter(Boolean);
    const parsed = createOAuthClientRequest.safeParse({
      name: name.trim() || "x",
      redirectUris,
      trusted,
      public: isPublic,
    });
    if (!parsed.success) found.uris = t("clients.urisInvalid");
    setErrors(found);
    if (Object.keys(found).length > 0 || !parsed.success) return;

    setBusy(true);
    try {
      const res = await api("/api/admin/oauth-clients", createOAuthClientResponse, {
        method: "POST",
        body: { ...parsed.data, name: name.trim() },
      });
      setCreated(res);
      await onCreated();
    } catch (err) {
      setFormError(errorMessage(err));
    }
    setBusy(false);
  }

  return (
    <Dialog open={open} onOpenChange={close}>
      <DialogContent>
        {created ? (
          <div className="flex flex-col gap-4">
            <DialogHeader>
              <DialogTitle>{t("clients.createdTitle", { name: created.client.name })}</DialogTitle>
              <DialogDescription>{t("clients.createdBody")}</DialogDescription>
            </DialogHeader>
            <CopyField
              label={t("clients.clientId")}
              value={created.client.clientId}
              copiedMessage={t("clients.idCopied")}
            />
            {created.clientSecret ? (
              <CopyField
                label={t("clients.clientSecret")}
                value={created.clientSecret}
                warning={t("clients.secretOnce")}
                copiedMessage={t("clients.secretCopied")}
              />
            ) : (
              <Callout tone="info">{t("clients.noSecret")}</Callout>
            )}
            <DialogFooter>
              <Button onClick={() => close(false)}>{t("common.done")}</Button>
            </DialogFooter>
          </div>
        ) : (
          <form onSubmit={submit} noValidate className="flex flex-col gap-4">
            <DialogHeader>
              <DialogTitle>{t("clients.createTitle")}</DialogTitle>
              <DialogDescription>{t("clients.createBody")}</DialogDescription>
            </DialogHeader>
            <div className="flex flex-col gap-2">
              <Label htmlFor="client-name">{t("clients.nameLabel")}</Label>
              <Input
                id="client-name"
                value={name}
                maxLength={100}
                onChange={(e) => setName(e.target.value)}
                aria-invalid={errors.name ? true : undefined}
                aria-describedby={errors.name ? "client-name-error" : undefined}
                autoFocus
              />
              {errors.name ? (
                <p id="client-name-error" role="alert" className="text-destructive text-sm">
                  {errors.name}
                </p>
              ) : null}
            </div>
            <div className="flex flex-col gap-2">
              <Label htmlFor="client-uris">{t("clients.urisLabel")}</Label>
              <Textarea
                id="client-uris"
                value={uris}
                rows={3}
                className="font-mono text-[13px]"
                spellCheck={false}
                autoCapitalize="none"
                onChange={(e) => setUris(e.target.value)}
                aria-invalid={errors.uris ? true : undefined}
                aria-describedby={errors.uris ? "client-uris-error" : "client-uris-hint"}
              />
              {errors.uris ? (
                <p id="client-uris-error" role="alert" className="text-destructive text-sm">
                  {errors.uris}
                </p>
              ) : (
                <p id="client-uris-hint" className="text-muted-foreground text-[13px]">
                  {t("clients.urisHint")}
                </p>
              )}
            </div>
            <div className="flex items-start justify-between gap-4">
              <div className="flex flex-col">
                <Label htmlFor="client-trusted">{t("clients.trustedLabel")}</Label>
                <p className="text-muted-foreground text-[13px]">{t("clients.trustedHint")}</p>
              </div>
              <Switch id="client-trusted" checked={trusted} onCheckedChange={setTrusted} />
            </div>
            <div className="flex items-start justify-between gap-4">
              <div className="flex flex-col">
                <Label htmlFor="client-public">{t("clients.publicLabel")}</Label>
                <p className="text-muted-foreground text-[13px]">{t("clients.publicHint")}</p>
              </div>
              <Switch id="client-public" checked={isPublic} onCheckedChange={setIsPublic} />
            </div>
            <FormError message={formError} />
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => close(false)}>
                {t("common.cancel")}
              </Button>
              <LoadingButton type="submit" loading={busy}>
                {t("clients.createSubmit")}
              </LoadingButton>
            </DialogFooter>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}
