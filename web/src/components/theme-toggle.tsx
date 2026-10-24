import { IconMoon, IconSun } from "@tabler/icons-react";
import { Button } from "@/components/ui/button";
import { useT } from "@/i18n";
import { useTheme } from "@/theme/theme";

export function ThemeToggle({ className }: { className?: string }) {
  const t = useT();
  const { resolved, toggle } = useTheme();
  const Icon = resolved === "dark" ? IconSun : IconMoon;
  return (
    <Button
      type="button"
      variant="ghost"
      size="icon"
      className={className}
      onClick={toggle}
      aria-label={t("theme.toggle")}
    >
      <Icon size={18} stroke={1.75} />
    </Button>
  );
}
