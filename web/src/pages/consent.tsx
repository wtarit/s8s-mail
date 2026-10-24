import { IconAlertCircle } from "@tabler/icons-react";
import { useEffect, useState } from "react";
import { Link, Navigate, useLocation, useSearchParams } from "react-router";
import { FormError } from "@/components/form-error";
import { LoadingButton } from "@/components/loading-button";
import { ScopeList } from "@/components/scope-list";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { UserAvatar } from "@/components/user-avatar";
import { authErrorMessage, getAuthClient, useAuthSession } from "@/lib/auth-client";
import { hasSignedOAuthQuery, loginPath } from "@/lib/navigation";
import { useT } from "@/i18n";

interface ClientInfo {
  name: string;
  logoUrl?: string;
}

/** Narrow the oauth-provider "public client" payload (snake_case OAuth metadata). */
function toClientInfo(data: unknown, fallbackName: string): ClientInfo {
  const d = (data ?? {}) as { client_name?: unknown; logo_uri?: unknown };
  return {
    name: typeof d.client_name === "string" && d.client_name ? d.client_name : fallbackName,
    logoUrl: typeof d.logo_uri === "string" && d.logo_uri ? d.logo_uri : undefined,
  };
}

export function ConsentPage() {
  const t = useT();
  const location = useLocation();
  const [params] = useSearchParams();
  const client = getAuthClient();
  const { data: session, isPending } = useAuthSession();

  const clientId = params.get("client_id") ?? "";
  const scopes = (params.get("scope") ?? "").split(/\s+/).filter(Boolean);
  const valid = Boolean(clientId) && hasSignedOAuthQuery(location.search);

  const [info, setInfo] = useState<ClientInfo>();
  const [infoLoaded, setInfoLoaded] = useState(false);
  const [busy, setBusy] = useState<"allow" | "deny" | null>(null);
  const [error, setError] = useState<string>();

  useEffect(() => {
    if (!valid || !session) return;
    let cancelled = false;
    void (async () => {
      try {
        const result = await client.oauth2.publicClient({ query: { client_id: clientId } });
        if (!cancelled) setInfo(toClientInfo(result.data, clientId));
      } catch {
        if (!cancelled) setInfo({ name: clientId });
      }
      if (!cancelled) setInfoLoaded(true);
    })();
    return () => {
      cancelled = true;
    };
  }, [client, clientId, valid, session]);

  async function decide(accept: boolean) {
    setBusy(accept ? "allow" : "deny");
    setError(undefined);
    try {
      // The oauth-provider client plugin attaches the signed query of this page.
      const result = await client.oauth2.consent({ accept });
      if (result.error) {
        setError(authErrorMessage(result.error, t("consent.failed")));
        setBusy(null);
        return;
      }
      // Better Auth's redirect plugin follows `{ redirect: true, url }` itself; older
      // servers answer `{ redirect_uri }`.
      const data = result.data as { redirect_uri?: unknown } | null;
      if (data && typeof data.redirect_uri === "string") window.location.assign(data.redirect_uri);
    } catch {
      setError(t("consent.failed"));
      setBusy(null);
    }
  }

  if (!valid) {
    return (
      <div className="flex flex-col gap-6">
        <div className="flex flex-col items-start gap-3">
          <IconAlertCircle size={32} stroke={1.5} className="text-destructive" aria-hidden="true" />
          <h1 className="text-2xl font-semibold">{t("consent.invalidTitle")}</h1>
          <p className="text-muted-foreground text-[15px]">{t("consent.invalidBody")}</p>
        </div>
        <Button asChild variant="outline" size="lg" className="h-11 rounded-lg text-[15px]">
          <Link to="/account/profile">{t("consent.toAccount")}</Link>
        </Button>
      </div>
    );
  }

  if (!isPending && !session) {
    return <Navigate to={loginPath(location.pathname + location.search)} replace />;
  }

  if (isPending || !session || !infoLoaded || !info) {
    return (
      <div className="flex flex-col gap-4" role="status" aria-label={t("app.loading")}>
        <Skeleton className="h-8 w-3/4" />
        <Skeleton className="h-12 w-full" />
        <Skeleton className="h-24 w-full" />
      </div>
    );
  }

  const user = session.user;
  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-2">
        {info.logoUrl ? (
          <img src={info.logoUrl} alt="" className="size-10 rounded-lg object-contain" />
        ) : null}
        <h1 className="text-2xl font-semibold">{t("consent.heading", { client: info.name })}</h1>
        <p className="text-muted-foreground text-[15px]">{t("consent.intro")}</p>
      </div>

      <div className="bg-muted flex items-center gap-3 rounded-lg px-4 py-3">
        <UserAvatar name={user.name} email={user.email} />
        <div className="min-w-0">
          <p className="text-muted-foreground text-[13px]">{t("consent.signedInAs")}</p>
          <p className="truncate text-[15px] font-semibold">{user.name || user.email}</p>
          <p className="text-muted-foreground truncate text-[13px]">{user.email}</p>
        </div>
      </div>

      <section className="flex flex-col gap-3" aria-labelledby="consent-scopes">
        <h2 id="consent-scopes" className="text-base font-semibold">
          {t("consent.scopesHeading", { client: info.name })}
        </h2>
        <ScopeList scopes={scopes} />
      </section>

      <FormError message={error} />

      <div className="flex flex-col-reverse gap-2 min-[400px]:flex-row min-[400px]:justify-end">
        <LoadingButton
          variant="outline"
          size="lg"
          className="h-11 rounded-lg text-[15px]"
          loading={busy === "deny"}
          disabled={busy !== null}
          onClick={() => void decide(false)}
        >
          {t("consent.deny")}
        </LoadingButton>
        <LoadingButton
          size="lg"
          className="h-11 rounded-lg text-[15px]"
          loading={busy === "allow"}
          disabled={busy !== null}
          onClick={() => void decide(true)}
        >
          {t("consent.allow")}
        </LoadingButton>
      </div>
    </div>
  );
}
