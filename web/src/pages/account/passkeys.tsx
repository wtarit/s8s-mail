import { IconFingerprint, IconPlus } from "@tabler/icons-react";
import { useState } from "react";
import { toast } from "sonner";
import { AddPasskeyForm } from "@/components/add-passkey-form";
import { EmptyState } from "@/components/empty-state";
import { ListSkeleton } from "@/components/list-skeleton";
import { LoadError } from "@/components/load-error";
import { useStepUp } from "@/components/step-up";
import { PageHeader } from "@/components/page-header";
import { PasskeyList, type PasskeyItem } from "@/components/passkey-list";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { getAuthClient } from "@/lib/auth-client";
import { unwrapAuth } from "@/lib/api";
import { useResource } from "@/lib/use-resource";
import { useT } from "@/i18n";

async function loadPasskeys(): Promise<PasskeyItem[]> {
  const list = await unwrapAuth(getAuthClient().passkey.listUserPasskeys());
  return list.map((p) => ({
    id: p.id,
    name: p.name ?? null,
    createdAt: p.createdAt,
    deviceType: p.deviceType,
  }));
}

export function PasskeysPage() {
  const t = useT();
  const { data, loading, error, reload } = useResource(loadPasskeys);
  const [adding, setAdding] = useState(false);
  const stepUp = useStepUp();

  const addButton = (
    <Button onClick={() => setAdding(true)}>
      <IconPlus size={18} stroke={1.75} />
      {t("passkeys.add")}
    </Button>
  );

  return (
    <>
      <PageHeader
        title={t("passkeys.title")}
        description={t("passkeys.description")}
        action={data && data.length > 0 ? addButton : undefined}
      />

      {loading ? <ListSkeleton /> : null}
      {error && !data ? <LoadError message={error} onRetry={() => void reload()} /> : null}
      {data && data.length === 0 ? (
        <EmptyState icon={IconFingerprint} message={t("passkeys.empty")} action={addButton} />
      ) : null}
      {data && data.length > 0 ? (
        <PasskeyList
          passkeys={data}
          onRename={async (id, name) => {
            await unwrapAuth(getAuthClient().passkey.updatePasskey({ id, name }));
            toast.success(t("passkeys.renamed"));
            await reload();
          }}
          onRemove={async (id) => {
            await stepUp.run(() => unwrapAuth(getAuthClient().passkey.deletePasskey({ id })));
            toast.success(t("passkeys.removed"));
            await reload();
          }}
        />
      ) : null}

      <Dialog open={adding} onOpenChange={setAdding}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("passkeys.addTitle")}</DialogTitle>
            <DialogDescription>{t("passkeys.addBody")}</DialogDescription>
          </DialogHeader>
          <AddPasskeyForm
            onAdded={async () => {
              setAdding(false);
              toast.success(t("passkeys.added"));
              await reload();
            }}
          >
            <Button type="button" variant="outline" onClick={() => setAdding(false)}>
              {t("common.cancel")}
            </Button>
          </AddPasskeyForm>
        </DialogContent>
      </Dialog>
    </>
  );
}
