import { newInviteResponse, type AdminUser, type Invite } from "#shared";
import { useState } from "react";
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
import { api, errorMessage } from "@/lib/api";
import { useT } from "@/i18n";

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
