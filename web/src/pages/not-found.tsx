import { Link } from "react-router";
import { Button } from "@/components/ui/button";
import { useT } from "@/i18n";

export function NotFoundPage() {
  const t = useT();
  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-2">
        <h1 className="text-2xl font-semibold">{t("notFound.title")}</h1>
        <p className="text-muted-foreground text-[15px]">{t("notFound.body")}</p>
      </div>
      <Button asChild variant="outline" size="lg" className="h-11 rounded-lg text-[15px]">
        <Link to="/account/profile">{t("notFound.home")}</Link>
      </Button>
    </div>
  );
}
