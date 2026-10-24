import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const target = "http://localhost:8787";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) },
  },
  server: {
    proxy: {
      "/api": target,
      "/jmap": target,
      "/.well-known": target,
    },
  },
  build: { outDir: "dist", emptyOutDir: true },
  test: {
    environment: "jsdom",
    globals: true,
    setupFiles: ["./src/test-setup.ts"],
    include: ["src/**/*.test.{ts,tsx}"],
    coverage: {
      provider: "istanbul",
      include: ["src/**/*.{ts,tsx}"],
      exclude: [
        "src/**/*.test.{ts,tsx}",
        "src/**/*.d.ts",
        "src/components/ui/**", // shadcn
        "src/main.tsx", // entry point
        "src/test-setup.ts",
        "src/test/**", // test helpers
      ],
      reporter: ["text-summary", "html"],
      reportsDirectory: "coverage",
      thresholds: { lines: 80, statements: 78, functions: 79, branches: 70 },
    },
  },
});
