import { IconAlertCircle } from "@tabler/icons-react";

/** Inline form-level error (announced to assistive tech). */
export function FormError({ message, className }: { message?: string; className?: string }) {
  if (!message) return null;
  return (
    <p
      role="alert"
      className={`text-destructive flex items-start gap-2 text-sm ${className ?? ""}`}
    >
      <IconAlertCircle size={16} stroke={1.75} className="mt-0.5 shrink-0" aria-hidden="true" />
      <span>{message}</span>
    </p>
  );
}
