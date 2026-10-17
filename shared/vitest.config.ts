import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    coverage: {
      provider: "istanbul",
      include: ["src/**/*.ts"],
      exclude: ["src/**/*.test.ts", "src/**/*.d.ts"],
      reporter: ["text-summary", "html"],
      reportsDirectory: "coverage",
      thresholds: { lines: 10, statements: 10, functions: 32, branches: 99 },
    },
  },
});
