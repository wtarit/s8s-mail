import path from "node:path";
import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";
import { ready, server } from "@serenity-kit/opaque";

export default defineConfig(async () => {
  await ready;
  const migrations = await readD1Migrations(path.join(import.meta.dirname, "drizzle/d1"));
  return {
    plugins: [
      cloudflareTest({
        wrangler: { configPath: path.join(import.meta.dirname, "../wrangler.jsonc") },
        miniflare: {
          bindings: {
            // Secrets are not in wrangler.jsonc; tests provide their own.
            BETTER_AUTH_SECRET: "test-only-secret-0123456789abcdef0123456789abcdef",
            BOOTSTRAP_TOKEN: "test-bootstrap-token",
            OPAQUE_SERVER_SETUP: server.createSetup(),
            TEST_MIGRATIONS: migrations,
          },
        },
      }),
    ],
    test: {
      name: "server",
      include: ["test/**/*.test.ts"],
      setupFiles: ["./test/helpers/setup.ts"],
      // The first request in a file cold-starts the Worker + DO (module loading takes seconds
      // under load, e.g. when the web and server projects run in parallel).
      testTimeout: 30_000,
      hookTimeout: 30_000,
    },
  };
});
