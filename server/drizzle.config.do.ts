import { defineConfig } from "drizzle-kit";

// Paths are relative to the repo root, where drizzle-kit runs (`pnpm db:generate:do`).
// Generates migrations for the per-account Durable Object SQLite. The generated
// `drizzle/do/migrations.js` is imported by AccountDO and run at DO startup.
export default defineConfig({
  dialect: "sqlite",
  driver: "durable-sqlite",
  schema: "./server/src/store/schema.ts",
  out: "./server/drizzle/do",
});
