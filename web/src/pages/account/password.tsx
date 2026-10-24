import { toast } from "sonner";
import { PageHeader } from "@/components/page-header";
import { PasswordForm } from "@/components/password-form";
import { useMe } from "@/lib/me";
import { useT } from "@/i18n";

export function PasswordPage() {
  const t = useT();
  const { me, reload } = useMe();
  const hasPassword = me.user.hasPassword;
  // First password and recovery need no current password; otherwise it is always asked.
  const requireCurrent = me.user.accountChange.currentPasswordRequired;
  const recovering = hasPassword && !requireCurrent;
  return (
    <>
      <PageHeader
        title={t("password.title")}
        description={t(
          recovering
            ? "password.descriptionRecovery"
            : hasPassword
              ? "password.descriptionChange"
              : "password.descriptionSet",
        )}
      />
      <div className="max-w-md">
        <PasswordForm
          requireCurrent={requireCurrent}
          submitLabel={t(hasPassword ? "password.change" : "password.set")}
          onDone={async () => {
            toast.success(t("password.saved"));
            await reload();
          }}
        />
      </div>
    </>
  );
}
