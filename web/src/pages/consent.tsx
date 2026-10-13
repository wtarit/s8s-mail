import { useT } from "@/i18n";

// Stub: the real page is implemented in a later task.
export function ConsentPage() {
  const t = useT();
  return <h1 className="text-2xl font-semibold">{t("consent.title")}</h1>;
}
