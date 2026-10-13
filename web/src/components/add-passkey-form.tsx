import { IconFingerprint } from "@tabler/icons-react";
import { useState, type FormEvent } from "react";
import { FormError } from "@/components/form-error";
import { LoadingButton } from "@/components/loading-button";
import { Field, FieldDescription, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { authErrorMessage, getAuthClient } from "@/lib/auth-client";
import { parseUserAgent } from "@/lib/user-agent";
import { useT } from "@/i18n";

/** Suggested device name from the user agent, e.g. "Firefox on Linux". */
export function suggestDeviceName(ua: string, t: ReturnType<typeof useT>): string {
  const { browser, os } = parseUserAgent(ua);
  if (browser && os) return t("device.browserOn", { browser, os });
  return browser ?? os ?? "";
}

interface AddPasskeyFormProps {
  onAdded: () => void | Promise<void>;
  large?: boolean;
  /** Extra controls rendered after the submit button (e.g. Cancel). */
  children?: React.ReactNode;
}

/** Name the device, then run the WebAuthn registration through Better Auth. */
export function AddPasskeyForm({ onAdded, large, children }: AddPasskeyFormProps) {
  const t = useT();
  const [name, setName] = useState(() => suggestDeviceName(navigator.userAgent, t));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const supported =
    typeof window !== "undefined" && typeof window.PublicKeyCredential === "function";

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!name.trim()) {
      setError(t("passkeys.nameRequired"));
      return;
    }
    setBusy(true);
    setError(undefined);
    try {
      const result = await getAuthClient().passkey.addPasskey({ name: name.trim() });
      if (result.error) {
        setError(authErrorMessage(result.error, t("passkeys.addFailed")));
        setBusy(false);
        return;
      }
      await onAdded();
    } catch {
      setError(t("passkeys.addFailed"));
    }
    setBusy(false);
  }

  return (
    <form onSubmit={submit} noValidate className="flex flex-col gap-4">
      <Field>
        <FieldLabel htmlFor="passkey-device-name">{t("passkeys.nameLabel")}</FieldLabel>
        <Input
          id="passkey-device-name"
          value={name}
          maxLength={100}
          className={large ? "h-11 rounded-lg text-[15px]" : undefined}
          onChange={(e) => setName(e.target.value)}
          aria-invalid={error ? true : undefined}
          aria-describedby="passkey-device-name-hint"
        />
        <FieldDescription id="passkey-device-name-hint">{t("passkeys.nameHint")}</FieldDescription>
      </Field>
      {!supported ? <FormError message={t("passkeys.unsupported")} /> : null}
      <FormError message={error} />
      <div className="flex flex-wrap items-center gap-2">
        <LoadingButton
          type="submit"
          size={large ? "lg" : "default"}
          className={large ? "h-11 rounded-lg text-[15px]" : undefined}
          loading={busy}
          disabled={!supported}
        >
          <IconFingerprint size={18} stroke={1.75} />
          {t("passkeys.create")}
        </LoadingButton>
        {children}
      </div>
    </form>
  );
}
