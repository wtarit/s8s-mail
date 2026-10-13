import { useT } from "@/i18n";

// Stub: the real page is implemented in a later task.
export function InvitePage() {
  const t = useT();
  return <h1 className="text-2xl font-semibold">{t("invite.title")}</h1>;
}
