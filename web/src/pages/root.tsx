import { useEffect } from "react";
import { Navigate } from "react-router";
import { useRuntimeConfig } from "@/config/runtime-config";
import { leaveApp } from "@/lib/navigation";

/** `/`: the webmail when the runtime config names one (it is not part of the SPA), else the account. */
export function RootPage() {
  const { webmailUrl } = useRuntimeConfig();
  useEffect(() => {
    if (webmailUrl) leaveApp(webmailUrl);
  }, [webmailUrl]);
  return webmailUrl ? null : <Navigate to="/account/profile" replace />;
}
