import { defineConfig } from "drizzle-kit";

// Generates migrations for the per-account Durable Object SQLite. The generated
// `drizzle/do/migrations.js` is imported by AccountDO and run at DO startup.
export default defineConfig({
  dialect: "sqlite",
  driver: "durable-sqlite",
  schema: "./src/store/schema.ts",
  out: "./drizzle/do",
});
