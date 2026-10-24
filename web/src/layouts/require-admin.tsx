import { Suspense } from "react";
import { Navigate, Outlet } from "react-router";
import { ListSkeleton } from "@/components/list-skeleton";
import { useMe } from "@/lib/me";

/** Route guard for `/admin/*`: role admin (from `GET /api/me`), else back to the profile. */
export function RequireAdmin() {
  const { me } = useMe();
  if (me.user.role !== "admin") return <Navigate to="/account/profile" replace />;
  return (
    <Suspense fallback={<ListSkeleton />}>
      <Outlet />
    </Suspense>
  );
}
