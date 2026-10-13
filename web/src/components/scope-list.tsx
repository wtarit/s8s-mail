import { IconCheck } from "@tabler/icons-react";
import { t as translate, useT, type MessageKey } from "@/i18n";

const SCOPE_LABELS: Record<string, MessageKey> = {
  openid: "scope.openid",
  profile: "scope.profile",
  email: "scope.email",
  offline_access: "scope.offlineAccess",
};

interface ScopeGroup {
  labelKey: MessageKey | null;
  scopes: string[];
}

/** Merge scopes that read the same ("profile" and "email" both show one line). */
export function groupScopes(scopes: string[]): ScopeGroup[] {
  const groups = new Map<string, ScopeGroup>();
  for (const scope of scopes) {
    const labelKey = SCOPE_LABELS[scope] ?? null;
    const id = labelKey ? translate(labelKey) : `raw:${scope}`;
    const existing = groups.get(id);
    if (existing) existing.scopes.push(scope);
    else groups.set(id, { labelKey, scopes: [scope] });
  }
  return [...groups.values()];
}

/** Consent screen: plain-language scope descriptions with the raw scope names underneath. */
export function ScopeList({ scopes }: { scopes: string[] }) {
  const t = useT();
  return (
    <ul className="flex flex-col gap-3" aria-label={t("scopeList.label")}>
      {groupScopes(scopes).map((group) => (
        <li key={group.scopes.join(" ")} className="flex items-start gap-3">
          <IconCheck
            size={18}
            stroke={1.75}
            className="text-success mt-0.5 shrink-0"
            aria-hidden="true"
          />
          <div className="flex flex-col">
            <span className="text-[15px]">
              {group.labelKey
                ? t(group.labelKey)
                : t("scope.unknown", { scope: group.scopes[0] ?? "" })}
            </span>
            <code className="text-muted-foreground font-mono text-xs">
              {group.scopes.join(", ")}
            </code>
          </div>
        </li>
      ))}
    </ul>
  );
}
