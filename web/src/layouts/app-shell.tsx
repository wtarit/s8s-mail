import {
  IconDeviceDesktop,
  IconFingerprint,
  IconKey,
  IconMail,
  IconMoon,
  IconApps,
  IconLogout,
  IconUser,
  IconUsers,
  IconWorld,
} from "@tabler/icons-react";
import { NavLink, Outlet, useMatch } from "react-router";
import type { ComponentType } from "react";
import { BrandLogo } from "@/components/brand-logo";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Sidebar,
  SidebarContent,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarInset,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarProvider,
  SidebarTrigger,
} from "@/components/ui/sidebar";
import { useRuntimeConfig } from "@/config/runtime-config";
import { useT, type MessageKey } from "@/i18n";
import { useTheme } from "@/theme/theme";

interface NavItem {
  to: string;
  labelKey: MessageKey;
  icon: ComponentType<{ size?: number; stroke?: number }>;
}

const accountNav: NavItem[] = [
  { to: "/account/profile", labelKey: "nav.profile", icon: IconUser },
  { to: "/account/passkeys", labelKey: "nav.passkeys", icon: IconFingerprint },
  { to: "/account/app-passwords", labelKey: "nav.appPasswords", icon: IconKey },
  { to: "/account/sessions", labelKey: "nav.sessions", icon: IconDeviceDesktop },
  { to: "/account/recovery", labelKey: "nav.recovery", icon: IconMail },
];

const adminNav: NavItem[] = [
  { to: "/admin/users", labelKey: "nav.users", icon: IconUsers },
  { to: "/admin/domains", labelKey: "nav.domains", icon: IconWorld },
  { to: "/admin/clients", labelKey: "nav.clients", icon: IconApps },
];

function NavEntry({ to, labelKey, icon: Icon }: NavItem) {
  const t = useT();
  const active = useMatch({ path: to, end: false }) !== null;
  return (
    <SidebarMenuItem>
      <SidebarMenuButton asChild isActive={active}>
        <NavLink to={to}>
          <Icon size={20} stroke={1.75} />
          <span>{t(labelKey)}</span>
        </NavLink>
      </SidebarMenuButton>
    </SidebarMenuItem>
  );
}

function NavGroup({ labelKey, items }: { labelKey: MessageKey; items: NavItem[] }) {
  const t = useT();
  return (
    <SidebarGroup>
      <SidebarGroupLabel>{t(labelKey)}</SidebarGroupLabel>
      <SidebarGroupContent>
        <SidebarMenu>
          {items.map((item) => (
            <NavEntry key={item.to} {...item} />
          ))}
        </SidebarMenu>
      </SidebarGroupContent>
    </SidebarGroup>
  );
}

function UserMenu() {
  const t = useT();
  const { resolved, toggle } = useTheme();
  const email = t("userMenu.placeholderEmail"); // TODO(auth): signed-in user's email
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="icon" aria-label={t("userMenu.label")}>
          <Avatar>
            <AvatarFallback>{email.charAt(0).toUpperCase()}</AvatarFallback>
          </Avatar>
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuLabel>{email}</DropdownMenuLabel>
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={toggle}>
          <IconMoon size={18} stroke={1.75} />
          {t("userMenu.theme")}: {t(resolved === "dark" ? "theme.dark" : "theme.light")}
        </DropdownMenuItem>
        <DropdownMenuItem disabled>
          <IconLogout size={18} stroke={1.75} />
          {t("userMenu.signOut")}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/**
 * Sidebar (240px, a sheet below 768px) plus a content column (design-system.md section 4).
 * TODO(auth): gate the Admin group on the signed-in user's role.
 */
export function AppShell() {
  const { appName } = useRuntimeConfig();
  return (
    <SidebarProvider style={{ "--sidebar-width": "15rem" } as React.CSSProperties}>
      <Sidebar>
        <SidebarHeader>
          <div className="flex items-center gap-2 px-2 py-1">
            <BrandLogo className="size-8 text-base" />
            <span className="text-lg font-semibold">{appName}</span>
          </div>
        </SidebarHeader>
        <SidebarContent>
          <NavGroup labelKey="nav.account" items={accountNav} />
          <NavGroup labelKey="nav.admin" items={adminNav} />
        </SidebarContent>
      </Sidebar>
      <SidebarInset>
        <header className="flex h-14 items-center justify-between gap-2 border-b px-4">
          <SidebarTrigger />
          <UserMenu />
        </header>
        <main className="mx-auto flex w-full max-w-4xl flex-col gap-8 p-4 md:p-8">
          <Outlet />
        </main>
      </SidebarInset>
    </SidebarProvider>
  );
}
