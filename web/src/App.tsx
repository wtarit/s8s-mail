import { Navigate, Route, Routes } from "react-router";
import { AppShell } from "@/layouts/app-shell";
import { AuthLayout } from "@/layouts/auth-layout";
import { PasskeysPage } from "@/pages/account/passkeys";
import { AppPasswordsPage } from "@/pages/account/app-passwords";
import { ProfilePage } from "@/pages/account/profile";
import { RecoveryPage } from "@/pages/account/recovery";
import { SessionsPage } from "@/pages/account/sessions";
import { ClientsPage } from "@/pages/admin/clients";
import { DomainsPage } from "@/pages/admin/domains";
import { UsersPage } from "@/pages/admin/users";
import { ConsentPage } from "@/pages/consent";
import { ErrorPage } from "@/pages/error";
import { InvitePage } from "@/pages/invite";
import { LoginPage } from "@/pages/login";
import { MagicLinkSentPage } from "@/pages/magic-link-sent";
import { MagicLinkVerifyPage } from "@/pages/magic-link-verify";
import { NotFoundPage } from "@/pages/not-found";

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

      <Route element={<AppShell />}>
        <Route path="/account">
          <Route index element={<Navigate to="profile" replace />} />
          <Route path="profile" element={<ProfilePage />} />
          <Route path="passkeys" element={<PasskeysPage />} />
          <Route path="app-passwords" element={<AppPasswordsPage />} />
          <Route path="sessions" element={<SessionsPage />} />
          <Route path="recovery" element={<RecoveryPage />} />
        </Route>
        <Route path="/admin">
          <Route index element={<Navigate to="users" replace />} />
          <Route path="users" element={<UsersPage />} />
          <Route path="domains" element={<DomainsPage />} />
          <Route path="clients" element={<ClientsPage />} />
        </Route>
      </Route>

      <Route path="/" element={<Navigate to="/account/profile" replace />} />
      <Route element={<AuthLayout />}>
        <Route path="*" element={<NotFoundPage />} />
      </Route>
    </Routes>
  );
}
