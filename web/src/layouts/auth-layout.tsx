import { Outlet } from "react-router";
import { BrandLogo } from "@/components/brand-logo";
import { ThemeToggle } from "@/components/theme-toggle";
import { useRuntimeConfig } from "@/config/runtime-config";
import { useT } from "@/i18n";

function deploymentDomain(source: string | undefined): string {
  try {
    return new URL(source || window.location.origin, window.location.origin).hostname;
  } catch {
    return window.location.hostname;
  }
}

/** Centered card on `background` for the unauthenticated pages (design-system.md section 4). */
export function AuthLayout() {
  const t = useT();
  const { appName, issuer, apiBaseUrl } = useRuntimeConfig();
  const domain = deploymentDomain(issuer ?? apiBaseUrl);

  return (
    <div className="bg-background flex min-h-svh flex-col items-center px-4">
      <main className="flex w-full flex-1 flex-col items-center justify-center gap-6 py-10">
        <div className="flex flex-col items-center gap-3">
          <BrandLogo />
          <span className="text-foreground text-lg font-semibold">{appName}</span>
        </div>
        <div className="bg-card text-card-foreground border-border/60 w-full max-w-[440px] rounded-xl border p-6 shadow-xl shadow-black/5 min-[400px]:p-8 dark:shadow-black/20">
          <Outlet />
        </div>
      </main>
      <footer className="text-muted-foreground flex w-full max-w-[440px] items-center justify-between pb-6 text-[13px]">
        <span>{t("authLayout.footer", { domain })}</span>
        <ThemeToggle />
      </footer>
    </div>
  );
}
