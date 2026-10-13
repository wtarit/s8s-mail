import { IconAlertTriangle, IconCheck, IconCopy } from "@tabler/icons-react";
import { useEffect, useId, useRef, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useT } from "@/i18n";

interface CopyFieldProps {
  label: string;
  value: string;
  /** Warning shown under the field, e.g. "shown once" for secrets. */
  warning?: string;
  /** Toast text after a successful copy. */
  copiedMessage?: string;
}

/** Read-only monospace value with a copy button (invite links, app passwords, client secrets). */
export function CopyField({ label, value, warning, copiedMessage }: CopyFieldProps) {
  const t = useT();
  const id = useId();
  const inputRef = useRef<HTMLInputElement>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 2000);
    return () => clearTimeout(timer);
  }, [copied]);

  async function copy() {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      toast.success(copiedMessage ?? t("copyField.copied"));
    } catch {
      inputRef.current?.select();
      toast.error(t("copyField.failed"));
    }
  }

  return (
    <div className="flex flex-col gap-2">
      <Label htmlFor={id}>{label}</Label>
      <div className="flex items-center gap-2">
        <Input
          ref={inputRef}
          id={id}
          readOnly
          value={value}
          className="font-mono text-[13px]"
          onFocus={(e) => e.currentTarget.select()}
        />
        <Button type="button" variant="outline" onClick={copy} className="shrink-0">
          {copied ? <IconCheck size={18} stroke={1.75} /> : <IconCopy size={18} stroke={1.75} />}
          {copied ? t("copyField.copiedShort") : t("copyField.copy")}
        </Button>
      </div>
      {warning ? (
        <p className="text-warning-foreground dark:text-warning flex items-start gap-2 text-[13px]">
          <IconAlertTriangle size={16} stroke={1.75} className="mt-0.5 shrink-0" />
          <span>{warning}</span>
        </p>
      ) : null}
    </div>
  );
}
