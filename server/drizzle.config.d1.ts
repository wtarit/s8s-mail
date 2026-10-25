import { defineConfig } from "drizzle-kit";

// Paths are relative to the repo root, where drizzle-kit runs (`pnpm db:generate:d1`).
// Generates SQL migrations for the global D1 directory. Apply with
// `wrangler d1 migrations apply` (migrations_dir in wrangler.jsonc points here).
export default defineConfig({
  dialect: "sqlite",
  schema: "./server/src/db/schema.ts",
  out: "./server/drizzle/d1",
});
