import { lazy } from "react";
import { Navigate, Route, Routes } from "react-router";
import { AppShell } from "@/layouts/app-shell";
import { AuthLayout } from "@/layouts/auth-layout";
import { RequireAdmin } from "@/layouts/require-admin";
import { RequireSession } from "@/layouts/require-session";
import { PasswordPage } from "@/pages/account/password";
import { PasskeysPage } from "@/pages/account/passkeys";
import { AppPasswordsPage } from "@/pages/account/app-passwords";
import { ProfilePage } from "@/pages/account/profile";
import { RecoveryPage } from "@/pages/account/recovery";
import { SessionsPage } from "@/pages/account/sessions";
import { ConsentPage } from "@/pages/consent";
import { ErrorPage } from "@/pages/error";
import { InvitePage } from "@/pages/invite";
import { LoginPage } from "@/pages/login";
import { MagicLinkSentPage } from "@/pages/magic-link-sent";
import { MagicLinkVerifyPage } from "@/pages/magic-link-verify";
import { NotFoundPage } from "@/pages/not-found";
import { RootPage } from "@/pages/root";

// Admin screens are only needed by admins: keep them out of the main bundle.
const UsersPage = lazy(() => import("@/pages/admin/users").then((m) => ({ default: m.UsersPage })));
const DomainsPage = lazy(() =>
  import("@/pages/admin/domains").then((m) => ({ default: m.DomainsPage })),
);
const ClientsPage = lazy(() =>
  import("@/pages/admin/clients").then((m) => ({ default: m.ClientsPage })),
);

export function AppRoutes() {
  return (
    <Routes>
      <Route element={<AuthLayout />}>
        <Route path="/login" element={<LoginPage />} />
        <Route path="/invite/:token" element={<InvitePage />} />
        <Route path="/magic-link/sent" element={<MagicLinkSentPage />} />
        <Route path="/magic-link/verify" element={<MagicLinkVerifyPage />} />
        <Route path="/consent" element={<ConsentPage />} />
        <Route path="/error" element={<ErrorPage />} />
      </Route>

      <Route element={<RequireSession />}>
        <Route element={<AppShell />}>
          <Route path="/account">
            <Route index element={<Navigate to="profile" replace />} />
            <Route path="profile" element={<ProfilePage />} />
            <Route path="passkeys" element={<PasskeysPage />} />
            <Route path="app-passwords" element={<AppPasswordsPage />} />
            <Route path="password" element={<PasswordPage />} />
            <Route path="sessions" element={<SessionsPage />} />
            <Route path="recovery" element={<RecoveryPage />} />
          </Route>
          <Route path="/admin" element={<RequireAdmin />}>
            <Route index element={<Navigate to="users" replace />} />
            <Route path="users" element={<UsersPage />} />
            <Route path="domains" element={<DomainsPage />} />
            <Route path="clients" element={<ClientsPage />} />
          </Route>
        </Route>
      </Route>

      <Route path="/" element={<RootPage />} />
      <Route element={<AuthLayout />}>
        <Route path="*" element={<NotFoundPage />} />
      </Route>
    </Routes>
  );
}
