import type { Auth } from "./auth";

export type { Auth } from "./auth";
export type { AppEnv, Principal, SessionUser } from "./types";

// Better Auth and its plugins are large. They are imported lazily, so requests that never touch
// auth (`email()` ingest, /api/health, CORS preflights) do not pay for evaluating them.

/** The cached per-isolate Better Auth instance for this env. */
export async function getAuth(env: Env): Promise<Auth> {
  const { createAuth } = await import("./auth");
  return createAuth(env);
}

export async function openIdConfig(env: Env, request: Request): Promise<Response> {
  const [m, auth] = await Promise.all([import("./auth"), getAuth(env)]);
  return m.openIdConfigResponse(auth, request);
}

export async function authServerMetadata(env: Env, request: Request): Promise<Response> {
  const [m, auth] = await Promise.all([import("./auth"), getAuth(env)]);
  return m.authServerMetadataResponse(auth, request);
}
