import { useT } from "@/i18n";

// Stub: the real page is implemented in a later task.
export function DomainsPage() {
  const t = useT();
  return <h1 className="text-lg font-semibold">{t("adminDomains.title")}</h1>;
}
