/**
 * Base URL of the s8s-mail API, set once at boot from runtime config (`apiBaseUrl`).
 * Empty config means "same origin as the SPA".
 */
let configuredBase = "";

export function configureApiBase(apiBaseUrl: string): void {
  configuredBase = apiBaseUrl.replace(/\/+$/, "");
}

export function getApiBase(): string {
  return configuredBase || window.location.origin;
}
