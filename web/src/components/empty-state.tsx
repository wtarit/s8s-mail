import type { ComponentType, ReactNode } from "react";

/** Icon, one line, one action (design-system.md section 3). */
export function EmptyState({
  icon: Icon,
  message,
  action,
}: {
  icon: ComponentType<{ size?: number; stroke?: number }>;
  message: string;
  action?: ReactNode;
}) {
  return (
    <div className="border-border text-muted-foreground flex flex-col items-center gap-3 rounded-xl border border-dashed px-4 py-10 text-center text-sm">
      <Icon size={28} stroke={1.5} />
      <p>{message}</p>
      {action}
    </div>
  );
}
