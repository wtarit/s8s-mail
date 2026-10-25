import { defineConfig } from "vitest/config";

// One run, three environments: the Worker in workerd, the SPA in jsdom, shared in Node.
// Coverage is configured only here; vitest ignores it in project configs.
export default defineConfig({
  test: {
    projects: [
      "server/vitest.config.ts",
      "web/vitest.config.ts",
      { test: { name: "shared", root: "shared", include: ["src/**/*.test.ts"] } },
    ],
    coverage: {
      // Istanbul, not V8: V8 coverage is unsupported inside workerd.
      provider: "istanbul",
      include: ["server/src/**/*.ts", "web/src/**/*.{ts,tsx}", "shared/src/**/*.ts"],
      exclude: [
        "**/*.test.{ts,tsx}",
        "**/*.d.ts",
        "server/src/db/auth-schema.ts",
        "web/src/components/ui/**", // shadcn
        "web/src/main.tsx", // entry point
        "web/src/test-setup.ts",
        "web/src/test/**", // test helpers
      ],
      reporter: ["text-summary", "html"],
      reportsDirectory: "coverage",
      thresholds: {
        "server/src/**": { lines: 90, statements: 88, functions: 89, branches: 76 },
        "web/src/**": { lines: 80, statements: 78, functions: 79, branches: 70 },
        "shared/src/**": { lines: 10, statements: 10, functions: 32, branches: 99 },
      },
    },
  },
});
