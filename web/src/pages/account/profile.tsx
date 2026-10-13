import { Badge } from "@/components/ui/badge";
import { PageHeader } from "@/components/page-header";
import { UserAvatar } from "@/components/user-avatar";
import { useMe } from "@/lib/me";
import { useT } from "@/i18n";

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="grid gap-1 py-3 sm:grid-cols-[10rem_1fr] sm:gap-4">
      <dt className="text-muted-foreground text-sm">{label}</dt>
      <dd className="min-w-0 text-sm break-words">{children}</dd>
    </div>
  );
}

export function ProfilePage() {
  const t = useT();
  const { me } = useMe();
  const { user, accounts } = me;
  const aliases = accounts
    .filter((a) => a.isPersonal)
    .flatMap((a) => a.addresses)
    .filter((a) => a.kind === "alias");

  return (
    <>
      <PageHeader title={t("profile.title")} description={t("profile.description")} />
      <div className="flex items-center gap-4">
        <UserAvatar name={user.name} email={user.email} size="lg" />
        <div className="min-w-0">
          <p className="truncate text-base font-semibold">{user.name}</p>
          <p className="text-muted-foreground truncate text-sm">{user.email}</p>
        </div>
      </div>
      <dl className="divide-border border-border divide-y rounded-xl border px-4">
        <Row label={t("profile.name")}>{user.name}</Row>
        <Row label={t("profile.email")}>{user.email}</Row>
        <Row label={t("profile.role")}>
          <Badge variant={user.role === "admin" ? "default" : "secondary"}>
            {t(user.role === "admin" ? "role.admin" : "role.user")}
          </Badge>
        </Row>
        {aliases.length > 0 ? (
          <Row label={t("profile.aliases")}>
            <ul className="flex flex-col gap-0.5">
              {aliases.map((a) => (
                <li key={a.address} className="font-mono text-[13px]">
                  {a.address}
                </li>
              ))}
            </ul>
          </Row>
        ) : null}
        <Row label={t("profile.recovery")}>
          <p className="font-mono text-[13px]">
            {user.recoveryEmailMasked ?? t("profile.recoveryNone")}
          </p>
          <p className="text-muted-foreground text-[13px]">{t("profile.recoveryHelp")}</p>
        </Row>
      </dl>
    </>
  );
}
