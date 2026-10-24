import { DEFAULT_RUNTIME_CONFIG, parseRuntimeConfig, type RuntimeConfig } from "@s8s/shared";
import { createContext, useContext, type ReactNode } from "react";

const RuntimeConfigContext = createContext<RuntimeConfig>(DEFAULT_RUNTIME_CONFIG);

/**
 * Fetch and validate `/config.json` (relative to the SPA origin). Any failure
 * (network, non-200, bad JSON, invalid shape) falls back to the defaults.
 */
export async function loadRuntimeConfig(url = "/config.json"): Promise<RuntimeConfig> {
  try {
    const res = await fetch(url, { cache: "no-store" });
    if (!res.ok) return { ...DEFAULT_RUNTIME_CONFIG };
    return parseRuntimeConfig(await res.json());
  } catch {
    return { ...DEFAULT_RUNTIME_CONFIG };
  }
}

export function RuntimeConfigProvider({
  config,
  children,
}: {
  config: RuntimeConfig;
  children: ReactNode;
}) {
  return <RuntimeConfigContext.Provider value={config}>{children}</RuntimeConfigContext.Provider>;
}

export function useRuntimeConfig(): RuntimeConfig {
  return useContext(RuntimeConfigContext);
}
