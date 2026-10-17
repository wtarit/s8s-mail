import { IconAlertCircle } from "@tabler/icons-react";
import { Link, useSearchParams } from "react-router";
import { Button } from "@/components/ui/button";
import { useT } from "@/i18n";

/** Landing page for Better Auth / OAuth errors (`?error=…&error_description=…`). */
export function ErrorPage() {
  const t = useT();
  const [params] = useSearchParams();
  const code = params.get("error");
  const description = params.get("error_description");
  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col items-start gap-3">
        <IconAlertCircle size={32} stroke={1.5} className="text-destructive" aria-hidden="true" />
        <h1 className="text-2xl font-semibold">{t("error.title")}</h1>
        <p className="text-muted-foreground text-[15px]">{description || t("error.pageBody")}</p>
        {code ? <code className="text-muted-foreground font-mono text-xs">{code}</code> : null}
      </div>
      <Button asChild variant="outline" size="lg" className="h-11 rounded-lg text-[15px]">
        <Link to="/login">{t("error.toLogin")}</Link>
      </Button>
    </div>
  );
}
