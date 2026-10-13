import { Skeleton } from "@/components/ui/skeleton";
import { useT } from "@/i18n";

export function ListSkeleton({ rows = 3 }: { rows?: number }) {
  const t = useT();
  return (
    <div className="flex flex-col gap-3" role="status" aria-label={t("app.loading")}>
      {Array.from({ length: rows }, (_, i) => (
        <Skeleton key={i} className="h-14 w-full rounded-lg" />
      ))}
    </div>
  );
}
