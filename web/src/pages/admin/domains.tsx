import { addDomainRequest, domainListResponse, type adminDomain } from "@s8s/shared";
import { IconPlus, IconTrash, IconWorld } from "@tabler/icons-react";
import { useState, type FormEvent } from "react";
import { toast } from "sonner";
import type { z } from "zod";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { EmptyState } from "@/components/empty-state";
import { FormError } from "@/components/form-error";
import { ListSkeleton } from "@/components/list-skeleton";
import { LoadError } from "@/components/load-error";
import { LoadingButton } from "@/components/loading-button";
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
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { api, apiVoid, errorMessage } from "@/lib/api";
import { formatDate } from "@/lib/format";
import { useResource } from "@/lib/use-resource";
import { useT } from "@/i18n";

type Domain = z.infer<typeof adminDomain>;

export function DomainsPage() {
  const t = useT();
  const { data, loading, error, reload } = useResource(() =>
    api("/api/admin/domains", domainListResponse),
  );
  const [adding, setAdding] = useState(false);
  const [removing, setRemoving] = useState<Domain | null>(null);
  const domains = data?.domains;

  const addButton = (
    <Button onClick={() => setAdding(true)}>
      <IconPlus size={18} stroke={1.75} />
      {t("domains.add")}
    </Button>
  );

  return (
    <>
      <PageHeader
        title={t("adminDomains.title")}
        description={t("domains.description")}
        action={domains && domains.length > 0 ? addButton : undefined}
      />

      {loading ? <ListSkeleton /> : null}
      {error && !data ? <LoadError message={error} onRetry={() => void reload()} /> : null}
      {domains && domains.length === 0 ? (
        <EmptyState icon={IconWorld} message={t("domains.empty")} action={addButton} />
      ) : null}

      {domains && domains.length > 0 ? (
        <div className="border-border overflow-x-auto rounded-xl border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t("domains.colName")}</TableHead>
                <TableHead>{t("domains.colAddresses")}</TableHead>
                <TableHead>{t("domains.colAdded")}</TableHead>
                <TableHead>
                  <span className="sr-only">{t("users.colActions")}</span>
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {domains.map((domain) => (
                <TableRow key={domain.name}>
                  <TableCell className="font-mono text-[13px]">{domain.name}</TableCell>
                  <TableCell>{domain.addressCount}</TableCell>
                  <TableCell className="text-muted-foreground">
                    {formatDate(domain.createdAt)}
                  </TableCell>
                  <TableCell className="text-right">
                    <Button
                      variant="ghost"
                      size="icon"
                      disabled={domain.addressCount > 0}
                      title={domain.addressCount > 0 ? t("domains.inUse") : undefined}
                      aria-label={t("domains.deleteAria", { name: domain.name })}
                      onClick={() => setRemoving(domain)}
                    >
                      <IconTrash size={18} stroke={1.75} />
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      ) : null}

      <AddDomainDialog open={adding} onOpenChange={setAdding} onAdded={reload} />

      <ConfirmDialog
        open={removing !== null}
        onOpenChange={(open) => !open && setRemoving(null)}
        title={t("domains.deleteTitle", { name: removing?.name ?? "" })}
        description={t("domains.deleteBody")}
        confirmLabel={t("domains.delete")}
        onConfirm={async () => {
          if (!removing) return;
          await apiVoid(`/api/admin/domains/${encodeURIComponent(removing.name)}`, {
            method: "DELETE",
          });
          toast.success(t("domains.deleted", { name: removing.name }));
          await reload();
        }}
      />
    </>
  );
}

function AddDomainDialog({
  open,
  onOpenChange,
  onAdded,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onAdded: () => Promise<void>;
}) {
  const t = useT();
  const [name, setName] = useState("");
  const [fieldError, setFieldError] = useState<string>();
  const [formError, setFormError] = useState<string>();
  const [busy, setBusy] = useState(false);

  function close(next: boolean) {
    onOpenChange(next);
    if (!next) {
      setName("");
      setFieldError(undefined);
      setFormError(undefined);
    }
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    setFormError(undefined);
    const parsed = addDomainRequest.safeParse({ name: name.trim() });
    if (!parsed.success) {
      setFieldError(t("domains.invalid"));
      return;
    }
    setFieldError(undefined);
    setBusy(true);
    try {
      await apiVoid("/api/admin/domains", { method: "POST", body: parsed.data });
      toast.success(t("domains.added", { name: parsed.data.name }));
      await onAdded();
      close(false);
    } catch (err) {
      setFormError(errorMessage(err));
    }
    setBusy(false);
  }

  return (
    <Dialog open={open} onOpenChange={close}>
      <DialogContent>
        <form onSubmit={submit} noValidate className="flex flex-col gap-4">
          <DialogHeader>
            <DialogTitle>{t("domains.addTitle")}</DialogTitle>
            <DialogDescription>{t("domains.addBody")}</DialogDescription>
          </DialogHeader>
          <div className="flex flex-col gap-2">
            <Label htmlFor="domain-name">{t("domains.nameLabel")}</Label>
            <Input
              id="domain-name"
              value={name}
              placeholder={t("domains.namePlaceholder")}
              autoCapitalize="none"
              spellCheck={false}
              onChange={(e) => setName(e.target.value)}
              aria-invalid={fieldError ? true : undefined}
              aria-describedby={fieldError ? "domain-name-error" : undefined}
              autoFocus
            />
            {fieldError ? (
              <p id="domain-name-error" role="alert" className="text-destructive text-sm">
                {fieldError}
              </p>
            ) : null}
          </div>
          <FormError message={formError} />
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => close(false)}>
              {t("common.cancel")}
            </Button>
            <LoadingButton type="submit" loading={busy}>
              {t("domains.addSubmit")}
            </LoadingButton>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
