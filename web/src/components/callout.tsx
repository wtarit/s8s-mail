import { IconAlertTriangle, IconCircleCheck, IconInfoCircle } from "@tabler/icons-react";
import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

type Tone = "info" | "warning" | "success";

const tones: Record<Tone, { box: string; icon: typeof IconInfoCircle }> = {
  info: { box: "border-info/40 bg-info/10", icon: IconInfoCircle },
  warning: { box: "border-warning/50 bg-warning/10", icon: IconAlertTriangle },
  success: { box: "border-success/40 bg-success/10", icon: IconCircleCheck },
};

/** Inline notice (expiry hints, "shown once" warnings). Not a status role: it is static content. */
export function Callout({
  tone = "info",
  children,
  className,
}: {
  tone?: Tone;
  children: ReactNode;
  className?: string;
}) {
  const { box, icon: Icon } = tones[tone];
  return (
    <div
      className={cn(
        "flex items-start gap-2 rounded-lg border px-3 py-2 text-[13px]",
        box,
        className,
      )}
    >
      <Icon size={16} stroke={1.75} className="mt-0.5 shrink-0" aria-hidden="true" />
      <div>{children}</div>
    </div>
  );
}
