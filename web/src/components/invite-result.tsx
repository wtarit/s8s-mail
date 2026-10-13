import type { Invite } from "@s8s/shared";
import { Callout } from "@/components/callout";
import { CopyField } from "@/components/copy-field";
import { formatDateTime } from "@/lib/format";
import { useT } from "@/i18n";

/** The one-time invite link, to hand over out of band, with its expiry. */
export function InviteResult({ invite, name }: { invite: Invite; name: string }) {
  const t = useT();
  return (
    <div className="flex flex-col gap-4">
      <CopyField
        label={t("invite.linkLabel")}
        value={invite.url}
        warning={t("invite.linkWarning", { name })}
        copiedMessage={t("invite.linkCopied")}
      />
      <Callout tone="warning">
        {t("invite.linkExpires", { date: formatDateTime(invite.expiresAt) })}
      </Callout>
    </div>
  );
}
