import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [cloudflareTest({ wrangler: { configPath: "./wrangler.jsonc" } })],
  test: {
    include: ["test/**/*.test.ts"],
    // The first request in a file cold-starts the Worker + DO (module loading takes seconds
    // under load, e.g. when `pnpm -r test` runs web and server tests in parallel).
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
