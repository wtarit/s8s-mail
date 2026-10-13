Better Auth setup and auth middleware.

- `auth.ts`: `makeAuth(env, database)` (all plugins) and `createAuth(env)` (cached per isolate). Import it only through `index.ts` (`getAuth`, lazy).
- `config.ts`: light constants (scopes, base path, app-password prefix) that cold-start code may import statically.
- `jmap-auth.ts`: `jmapAuth` Hono middleware for the JMAP module. Sets `c.var.principal` (`Principal` in `types.ts`).
- `invite-session-plugin.ts`: server-only endpoint that starts a session after an invite is accepted.
- `request-context.ts`: `runInBackground()` (`waitUntil` via AsyncLocalStorage).
- Schema: `../db/auth-schema.ts` is generated, see CLAUDE.md "Better Auth on Workers".
