import type { UserStatus } from "@s8s/shared";
import { Badge } from "@/components/ui/badge";
import { useT, type MessageKey } from "@/i18n";
import { cn } from "@/lib/utils";

const STATUS: Record<UserStatus, { label: MessageKey; dot: string }> = {
  active: { label: "status.active", dot: "bg-success" },
  invited: { label: "status.invited", dot: "bg-info" },
  disabled: { label: "status.disabled", dot: "bg-muted-foreground" },
};

/** Status chip: a coloured dot plus a text label (never colour alone). */
export function StatusBadge({ status }: { status: UserStatus }) {
  const t = useT();
  const { label, dot } = STATUS[status];
  return (
    <Badge variant="outline">
      <span className={cn("size-1.5 rounded-full", dot)} aria-hidden="true" />
      {t(label)}
    </Badge>
  );
}
