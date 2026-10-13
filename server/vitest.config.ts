import path from "node:path";
import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

export default defineConfig(async () => {
  const migrations = await readD1Migrations(path.join(import.meta.dirname, "drizzle/d1"));
  return {
    plugins: [
      cloudflareTest({
        wrangler: { configPath: "./wrangler.jsonc" },
        miniflare: {
          bindings: {
            // Secrets are not in wrangler.jsonc; tests provide their own.
            BETTER_AUTH_SECRET: "test-only-secret-0123456789abcdef0123456789abcdef",
            BOOTSTRAP_TOKEN: "test-bootstrap-token",
            TEST_MIGRATIONS: migrations,
          },
        },
      }),
    ],
    test: {
      include: ["test/**/*.test.ts"],
      setupFiles: ["./test/setup.ts"],
      // The first request in a file cold-starts the Worker + DO (module loading takes seconds
      // under load, e.g. when `pnpm -r test` runs web and server tests in parallel).
      testTimeout: 30_000,
      hookTimeout: 30_000,
    },
  };
});
