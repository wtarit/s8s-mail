import { z } from "zod";

/**
 * Runtime configuration of the SPA, served as `/config.json` next to `index.html`.
 * Branding and the API base URL are runtime config, never build constants, so the
 * same bundle works when bundled with the Worker or deployed headless.
 */
export const RuntimeConfig = z.object({
  /** Base URL of the s8s-mail API. Empty string = same origin as the SPA. */
  apiBaseUrl: z.string().default(""),
  /** OIDC issuer URL; defaults to the API origin when omitted. */
  issuer: z.string().optional(),
  appName: z.string().min(1).default("S8S Mail"),
  logoLightUrl: z.string().optional(),
  logoDarkUrl: z.string().optional(),
});

export type RuntimeConfig = z.infer<typeof RuntimeConfig>;

export const DEFAULT_RUNTIME_CONFIG: RuntimeConfig = RuntimeConfig.parse({});

/**
 * Validate an untrusted `config.json` payload. Falls back to defaults when the
 * payload is missing or invalid, so a broken config never blocks the SPA.
 */
export function parseRuntimeConfig(input: unknown): RuntimeConfig {
  const result = RuntimeConfig.safeParse(input);
  return result.success ? result.data : { ...DEFAULT_RUNTIME_CONFIG };
}
