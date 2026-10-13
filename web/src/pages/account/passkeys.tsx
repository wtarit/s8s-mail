import { useT } from "@/i18n";

// Stub: the real page is implemented in a later task.
export function PasskeysPage() {
  const t = useT();
  return <h1 className="text-lg font-semibold">{t("passkeys.title")}</h1>;
}
