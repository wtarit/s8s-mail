import { IconLoader2 } from "@tabler/icons-react";
import type { ComponentProps } from "react";
import { Button } from "@/components/ui/button";

type LoadingButtonProps = ComponentProps<typeof Button> & { loading?: boolean };

/** Button that shows a spinner and is disabled while `loading`. */
export function LoadingButton({ loading, disabled, children, ...props }: LoadingButtonProps) {
  return (
    <Button disabled={disabled || loading} aria-busy={loading || undefined} {...props}>
      {loading ? <IconLoader2 size={18} stroke={1.75} className="animate-spin" /> : null}
      {children}
    </Button>
  );
}
