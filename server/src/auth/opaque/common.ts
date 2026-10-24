import { APIError } from "better-auth/api";
import { z } from "zod";

export type OpaqueEnv = Pick<Env, "DB" | "BETTER_AUTH_SECRET"> & { OPAQUE_SERVER_SETUP?: string };
export const CHALLENGE_TTL = 5 * 60 * 1000;
// Serialized OPAQUE messages are small base64url strings. Bound before WASM decoding.
export const message = z
  .string()
  .min(1)
  .max(2048)
  .regex(/^[A-Za-z0-9_+/=-]+$/);
export const challengeId = z.string().uuid();
export const oauthQuery = { oauth_query: z.string().max(8192).optional() };

export function invalidCredentials(): never {
  throw APIError.from("UNAUTHORIZED", {
    code: "INVALID_EMAIL_OR_PASSWORD",
    message: "Invalid email or password",
  });
}
export function conflict(): never {
  throw APIError.from("CONFLICT", {
    code: "OPAQUE_CHALLENGE_INVALID",
    message: "Authentication changed or the request expired. Please try again.",
  });
}
export async function protocol(env: OpaqueEnv) {
  // Keep schema generation usable in Node, and avoid loading Wasm for non-password auth.
  const { getOpaqueServer } = await import("../opaque-runtime");
  const server = await getOpaqueServer();
  if (!env.OPAQUE_SERVER_SETUP)
    throw APIError.from("SERVICE_UNAVAILABLE", {
      code: "OPAQUE_NOT_CONFIGURED",
      message: "Password authentication is not configured.",
    });
  try {
    server.getPublicKey(env.OPAQUE_SERVER_SETUP);
    return { server, serverSetup: env.OPAQUE_SERVER_SETUP };
  } catch {
    throw APIError.from("SERVICE_UNAVAILABLE", {
      code: "OPAQUE_NOT_CONFIGURED",
      message: "Password authentication is not configured.",
    });
  }
}
