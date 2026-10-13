import { meResponse, type MeResponse } from "@s8s/shared";
import { createContext, useContext, type ReactNode } from "react";
import { Navigate, useLocation } from "react-router";
import { LoadError } from "@/components/load-error";
import { Skeleton } from "@/components/ui/skeleton";
import { api } from "@/lib/api";
import { loginPath } from "@/lib/navigation";
import { useResource } from "@/lib/use-resource";
import { useT } from "@/i18n";

interface MeContextValue {
  me: MeResponse;
  reload: () => Promise<void>;
}

const MeContext = createContext<MeContextValue | null>(null);

export function fetchMe(): Promise<MeResponse> {
  return api("/api/me", meResponse);
}

/** Loads `GET /api/me` and provides it to the app shell. A 401 sends the user to /login. */
export function MeProvider({ children }: { children: ReactNode }) {
  const t = useT();
  const location = useLocation();
  const { data, error, errorStatus, reload, loading } = useResource(fetchMe);

  if (data) return <MeContext.Provider value={{ me: data, reload }}>{children}</MeContext.Provider>;
  if (loading) {
    return (
      <div className="flex flex-col gap-4 p-8" role="status" aria-label={t("app.loading")}>
        <Skeleton className="h-8 w-48" />
        <Skeleton className="h-32 w-full" />
      </div>
    );
  }
  if (errorStatus === 401) {
    return <Navigate to={loginPath(location.pathname + location.search)} replace />;
  }
  return (
    <div className="p-8">
      <LoadError message={error ?? t("error.generic")} onRetry={() => void reload()} />
    </div>
  );
}

export function useMe(): MeContextValue {
  const ctx = useContext(MeContext);
  if (!ctx) throw new Error("useMe must be used inside <MeProvider>");
  return ctx;
}
