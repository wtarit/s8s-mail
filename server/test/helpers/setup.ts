import type { D1Migration } from "@cloudflare/vitest-plugin";
import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";

// Applies drizzle/d1/*.sql to the test D1 (idempotent).
await applyD1Migrations(
  env.DB,
  (env as unknown as { TEST_MIGRATIONS: D1Migration[] }).TEST_MIGRATIONS,
);
