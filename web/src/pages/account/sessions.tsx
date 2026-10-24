import { IconDeviceDesktop, IconDeviceMobile } from "@tabler/icons-react";
import { useState } from "react";
import { toast } from "sonner";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { ListSkeleton } from "@/components/list-skeleton";
import { LoadError } from "@/components/load-error";
import { PageHeader } from "@/components/page-header";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { unwrapAuth } from "@/lib/api";
import { getAuthClient, useAuthSession } from "@/lib/auth-client";
import { formatDateTime } from "@/lib/format";
import { parseUserAgent } from "@/lib/user-agent";
import { useResource } from "@/lib/use-resource";
import { useT } from "@/i18n";

interface SessionItem {
  id: string;
  token: string;
  userAgent: string | null;
  ipAddress: string | null;
  updatedAt: Date | string;
  createdAt: Date | string;
}

async function loadSessions(): Promise<SessionItem[]> {
  const list = await unwrapAuth(getAuthClient().listSessions());
  return list.map((s) => ({
    id: s.id,
    token: s.token,
    userAgent: s.userAgent ?? null,
    ipAddress: s.ipAddress ?? null,
    updatedAt: s.updatedAt,
    createdAt: s.createdAt,
  }));
}

export function SessionsPage() {
  const t = useT();
  const client = getAuthClient();
  const { data: current } = useAuthSession();
  const { data, loading, error, reload } = useResource(loadSessions);
  const [revoking, setRevoking] = useState<SessionItem | null>(null);
  const [revokingOthers, setRevokingOthers] = useState(false);

  const currentToken = current?.session.token;
  const others = (data ?? []).filter((s) => s.token !== currentToken);

  function deviceLabel(s: SessionItem): string {
    const { browser, os } = parseUserAgent(s.userAgent);
    if (browser && os) return t("device.browserOn", { browser, os });
    return browser ?? os ?? t("sessions.unknownDevice");
  }

  return (
    <>
      <PageHeader
        title={t("sessions.title")}
        description={t("sessions.description")}
        action={
          others.length > 0 ? (
            <Button variant="outline" onClick={() => setRevokingOthers(true)}>
              {t("sessions.signOutOthers")}
            </Button>
          ) : undefined
        }
      />

      {loading ? <ListSkeleton /> : null}
      {error && !data ? <LoadError message={error} onRetry={() => void reload()} /> : null}
      {data ? (
        <ul className="divide-border border-border divide-y rounded-xl border">
          {data.map((s) => {
            const isCurrent = s.token === currentToken;
            const Icon = /Android|iPhone|iPad|Mobile/.test(s.userAgent ?? "")
              ? IconDeviceMobile
              : IconDeviceDesktop;
            return (
              <li key={s.id} className="flex items-center gap-3 p-3">
                <Icon size={20} stroke={1.75} className="text-muted-foreground shrink-0" />
                <div className="min-w-0 flex-1">
                  <p className="flex flex-wrap items-center gap-2 text-sm font-medium">
                    <span className="truncate">{deviceLabel(s)}</span>
                    {isCurrent ? <Badge variant="secondary">{t("sessions.current")}</Badge> : null}
                  </p>
                  <p className="text-muted-foreground text-[13px]">
                    {t("sessions.lastActive", { date: formatDateTime(s.updatedAt) })}
                    {s.ipAddress ? ` · ${s.ipAddress}` : ""}
                  </p>
                </div>
                {!isCurrent ? (
                  <Button
                    variant="outline"
                    size="sm"
                    aria-label={t("sessions.revokeAria", { device: deviceLabel(s) })}
                    onClick={() => setRevoking(s)}
                  >
                    {t("sessions.revoke")}
                  </Button>
                ) : null}
              </li>
            );
          })}
        </ul>
      ) : null}

      <ConfirmDialog
        open={revoking !== null}
        onOpenChange={(open) => !open && setRevoking(null)}
        title={t("sessions.revokeTitle", { device: revoking ? deviceLabel(revoking) : "" })}
        description={t("sessions.revokeBody")}
        confirmLabel={t("sessions.revoke")}
        onConfirm={async () => {
          if (!revoking) return;
          await unwrapAuth(client.revokeSession({ token: revoking.token }));
          toast.success(t("sessions.revoked"));
          await reload();
        }}
      />

      <ConfirmDialog
        open={revokingOthers}
        onOpenChange={setRevokingOthers}
        title={t("sessions.revokeOthersTitle")}
        description={t("sessions.revokeOthersBody", { count: others.length })}
        confirmLabel={t("sessions.signOutOthers")}
        onConfirm={async () => {
          await unwrapAuth(client.revokeOtherSessions());
          toast.success(t("sessions.revokedOthers"));
          await reload();
        }}
      />
    </>
  );
}
