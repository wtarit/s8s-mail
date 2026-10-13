import { useT } from "@/i18n";

// Stub: the real page is implemented in a later task.
export function ErrorPage() {
  const t = useT();
  return <h1 className="text-2xl font-semibold">{t("error.title")}</h1>;
}
