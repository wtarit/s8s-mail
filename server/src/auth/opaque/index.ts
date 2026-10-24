import type { BetterAuthPlugin } from "better-auth";
import type { OpaqueEnv } from "./common";
import { loginEndpoints } from "./login";
import { passwordEndpoints } from "./password";
import { stepUpEndpoints } from "./step-up";

/** OPAQUE password endpoints: sign-in, set/change, and step-up for an existing session. */
export const opaque = (env: OpaqueEnv) =>
  ({
    id: "s8s-opaque",
    endpoints: { ...loginEndpoints(env), ...passwordEndpoints(env), ...stepUpEndpoints(env) },
  }) satisfies BetterAuthPlugin;
