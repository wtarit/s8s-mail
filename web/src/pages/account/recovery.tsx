import { IconMailForward } from "@tabler/icons-react";
import { Callout } from "@/components/callout";
import { PageHeader } from "@/components/page-header";
import { useMe } from "@/lib/me";
import { useT } from "@/i18n";

/** Read-only: only an admin can change the recovery address. */
export function RecoveryPage() {
  const t = useT();
  const { me } = useMe();
  return (
    <>
      <PageHeader title={t("recovery.title")} description={t("recovery.description")} />
      <div className="border-border flex items-center gap-3 rounded-xl border p-4">
        <IconMailForward size={24} stroke={1.5} className="text-muted-foreground shrink-0" />
        <div className="min-w-0">
          <p className="font-mono text-sm">
            {me.user.recoveryEmailMasked ?? t("profile.recoveryNone")}
          </p>
          <p className="text-muted-foreground text-[13px]">{t("profile.recoveryHelp")}</p>
        </div>
      </div>
      <Callout tone="info">{t("recovery.explainer")}</Callout>
    </>
  );
}
