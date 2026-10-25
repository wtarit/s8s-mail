import { adminAddressListResponse, domainListResponse, type AdminDomain } from "#shared";
import { useState, type FormEvent } from "react";
import { toast } from "sonner";
import { FormError } from "@/components/form-error";
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
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { api, errorMessage } from "@/lib/api";
import { useMe } from "@/lib/me";
import { useResource } from "@/lib/use-resource";
import { useT } from "@/i18n";

/** Per-domain catch-all editor: reject unknown addresses (default) or deliver them to a mailbox. */
export function CatchAllDialog({
  domain,
  onOpenChange,
  onSaved,
}: {
  /** The domain being edited; the dialog is open while this is set. */
  domain: AdminDomain | null;
  onOpenChange: (open: boolean) => void;
  onSaved: () => Promise<void>;
}) {
  return (
    <Dialog open={domain !== null} onOpenChange={onOpenChange}>
      <DialogContent>
        {domain ? (
          <CatchAllForm
            key={domain.name}
            domain={domain}
            onClose={() => onOpenChange(false)}
            onSaved={onSaved}
          />
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

function CatchAllForm({
  domain,
  onClose,
  onSaved,
}: {
  domain: AdminDomain;
  onClose: () => void;
  onSaved: () => Promise<void>;
}) {
  const t = useT();
  const { me } = useMe();
  const addresses = useResource(() => api("/api/admin/addresses", adminAddressListResponse));
  const ownPrimary = me.accounts
    .flatMap((a) => (a.isPersonal ? a.addresses : []))
    .find((a) => a.kind === "primary")?.address;

  const [mode, setMode] = useState<"reject" | "deliver">(
    domain.catchAllAddress ? "deliver" : "reject",
  );
  // Suggest the current admin's own mailbox until they pick something else.
  const [target, setTarget] = useState(domain.catchAllAddress ?? ownPrimary ?? me.user.email);
  const [formError, setFormError] = useState<string>();
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setFormError(undefined);
    setBusy(true);
    try {
      await api(`/api/admin/domains/${encodeURIComponent(domain.name)}`, domainListResponse, {
        method: "PATCH",
        body: { catchAllAddress: mode === "deliver" ? target : null },
      });
      toast.success(t("domains.catchAllSaved", { name: domain.name }));
      await onSaved();
      onClose();
      return;
    } catch (err) {
      setFormError(errorMessage(err));
    }
    setBusy(false);
  }

  const options = [...(addresses.data?.addresses ?? [])];
  // Keep the current value selectable even if the list is momentarily out of date.
  if (target && options.length > 0 && !options.some((o) => o.address === target)) {
    options.push({ address: target, kind: "alias", accountName: "" });
  }

  return (
    <form onSubmit={submit} noValidate className="flex flex-col gap-4">
      <DialogHeader>
        <DialogTitle>{t("domains.catchAllTitle", { name: domain.name })}</DialogTitle>
        <DialogDescription>{t("domains.catchAllBody")}</DialogDescription>
      </DialogHeader>

      <fieldset className="flex flex-col gap-3">
        <legend className="sr-only">{t("domains.colCatchAll")}</legend>
        <RadioRow
          id="catch-all-reject"
          checked={mode === "reject"}
          onSelect={() => setMode("reject")}
          label={t("domains.catchAllReject")}
          hint={t("domains.catchAllRejectHint")}
        />
        <RadioRow
          id="catch-all-deliver"
          checked={mode === "deliver"}
          onSelect={() => setMode("deliver")}
          label={t("domains.catchAllDeliver")}
        />
      </fieldset>

      {mode === "deliver" ? (
        <div className="flex flex-col gap-2 pl-7">
          <Label htmlFor="catch-all-address">{t("domains.catchAllAddressLabel")}</Label>
          {addresses.loading ? <Skeleton className="h-8 w-full" /> : null}
          {addresses.error && !addresses.data ? (
            <LoadError
              message={t("domains.catchAllLoadFailed")}
              onRetry={() => void addresses.reload()}
            />
          ) : null}
          {addresses.data ? (
            <Select value={target} onValueChange={setTarget}>
              <SelectTrigger id="catch-all-address" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {options.map((o) => (
                  <SelectItem key={o.address} value={o.address}>
                    {o.address}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          ) : null}
          <p className="text-muted-foreground text-sm">
            {t("domains.catchAllDeliverHint", { domain: domain.name })}
          </p>
        </div>
      ) : null}

      <FormError message={formError} />
      <DialogFooter>
        <Button type="button" variant="outline" onClick={onClose}>
          {t("common.cancel")}
        </Button>
        <LoadingButton type="submit" loading={busy} disabled={mode === "deliver" && !target}>
          {t("common.save")}
        </LoadingButton>
      </DialogFooter>
    </form>
  );
}

function RadioRow({
  id,
  checked,
  onSelect,
  label,
  hint,
}: {
  id: string;
  checked: boolean;
  onSelect: () => void;
  label: string;
  hint?: string;
}) {
  return (
    <div className="flex items-start gap-3">
      <input
        type="radio"
        id={id}
        name="catch-all-mode"
        checked={checked}
        onChange={onSelect}
        aria-describedby={hint ? `${id}-hint` : undefined}
        className="accent-primary mt-1 size-4"
      />
      <div className="flex flex-col gap-0.5">
        <Label htmlFor={id}>{label}</Label>
        {hint ? (
          <p id={`${id}-hint`} className="text-muted-foreground text-sm">
            {hint}
          </p>
        ) : null}
      </div>
    </div>
  );
}
