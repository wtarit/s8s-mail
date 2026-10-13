D1 Drizzle schema (`schema.ts`) for the global directory plus the `invite` table. No mail data in D1.
`auth-schema.ts` is Better Auth's generated schema (re-exported from `schema.ts`); regenerate it when the plugin set changes (CLAUDE.md).
Migrations: edit `schema.ts`, run `pnpm db:generate:d1`, commit `drizzle/d1/`, apply with `pnpm db:migrate:local`.
