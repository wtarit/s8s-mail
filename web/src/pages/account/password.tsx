import { toast } from "sonner";
import { PageHeader } from "@/components/page-header";
import { PasswordForm } from "@/components/password-form";
import { useMe } from "@/lib/me";
import { useT } from "@/i18n";

export function PasswordPage() {
  const t = useT();
  const { me, reload } = useMe();
  const hasPassword = me.user.hasPassword;
  return (
    <>
      <PageHeader
        title={t("password.title")}
        description={t(hasPassword ? "password.descriptionChange" : "password.descriptionSet")}
      />
      <div className="max-w-md">
        <PasswordForm
          requireCurrent={hasPassword}
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
