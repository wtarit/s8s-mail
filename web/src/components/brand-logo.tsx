import { useRuntimeConfig } from "@/config/runtime-config";
import { useT } from "@/i18n";
import { cn } from "@/lib/utils";

/**
 * Deployment logo. Renders `logoLightUrl` / `logoDarkUrl` from runtime config when set
 * (swapped by the `.dark` class), else a rounded-square letter mark from the app name.
 */
export function BrandLogo({ className }: { className?: string }) {
  const { appName, logoLightUrl, logoDarkUrl } = useRuntimeConfig();
  const t = useT();
  const alt = t("brand.logoAlt", { appName });

  if (logoLightUrl || logoDarkUrl) {
    const light = logoLightUrl ?? logoDarkUrl;
    const dark = logoDarkUrl ?? logoLightUrl;
    return (
      <>
        <img src={light} alt={alt} className={cn("h-9 w-auto dark:hidden", className)} />
        <img src={dark} alt={alt} className={cn("hidden h-9 w-auto dark:block", className)} />
      </>
    );
  }

  return (
    <span
      role="img"
      aria-label={alt}
      className={cn(
        "bg-primary text-primary-foreground inline-flex size-9 items-center justify-center rounded-lg text-lg font-semibold select-none",
        className,
      )}
    >
      {appName.trim().charAt(0).toUpperCase() || "S"}
    </span>
  );
}
