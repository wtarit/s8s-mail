import { Navigate, Outlet, useLocation } from "react-router";
import { MeStepUpProvider } from "@/components/step-up";
import { Skeleton } from "@/components/ui/skeleton";
import { useAuthSession } from "@/lib/auth-client";
import { MeProvider } from "@/lib/me";
import { loginPath } from "@/lib/navigation";
import { useT } from "@/i18n";

/** Route guard: needs a Better Auth session, else redirects to `/login?next=…`. */
export function RequireSession() {
  const t = useT();
  const location = useLocation();
  const { data: session, isPending } = useAuthSession();

  if (isPending) {
    return (
      <div className="flex flex-col gap-4 p-8" role="status" aria-label={t("app.loading")}>
        <Skeleton className="h-8 w-48" />
        <Skeleton className="h-32 w-full" />
      </div>
    );
  }
  if (!session) {
    return <Navigate to={loginPath(location.pathname + location.search)} replace />;
  }
  return (
    <MeProvider>
      <MeStepUpProvider>
        <Outlet />
      </MeStepUpProvider>
    </MeProvider>
  );
}
