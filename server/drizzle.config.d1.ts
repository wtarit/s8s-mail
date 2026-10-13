import { defineConfig } from "drizzle-kit";

// Generates SQL migrations for the global D1 directory. Apply with
// `wrangler d1 migrations apply` (migrations_dir in wrangler.jsonc points here).
export default defineConfig({
  dialect: "sqlite",
  schema: "./src/db/schema.ts",
  out: "./drizzle/d1",
});
