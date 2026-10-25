// Only used by the Better Auth CLI to generate src/db/auth-schema.ts:
//   pnpm dlx auth@1.7.7 generate --config auth.config.ts --output src/db/auth-schema.ts
// It builds the same plugin set as the Worker, with a stub database.
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { makeAuth } from "./src/auth/auth";

export const auth = makeAuth(
  {
    DB: undefined as unknown as D1Database,
    PUBLIC_URL: "http://localhost:8787",
    APP_NAME: "S8S Mail",
    BETTER_AUTH_SECRET: "schema-generation-only-secret-0000000000000000",
  },
  drizzleAdapter({} as never, { provider: "sqlite" }),
);
