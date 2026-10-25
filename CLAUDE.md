# s8s-mail

Serverless JMAP mail server on Cloudflare Workers. Features, architecture and commands: `README.md`. Deploying: `docs/deploy.md`.

## Tooling

- **pnpm only**, never npm or yarn. Wrangler is a local dev dependency (`pnpm wrangler …`); never install it globally.
- **One package.** Run every command from the repo root: no `--filter`, no `cd server`. `server/`, `web/` and `shared/` never import each other by path; shared code goes through `#shared` (oxlint enforces it).
- Before finishing a change: `pnpm lint && pnpm format:check && pnpm typecheck && pnpm test`.
- **Max 300 lines per file**, tests included (oxlint `max-lines`). Split along real seams and keep the import path stable (`foo.ts` → `foo/index.ts`).
- After editing `wrangler.jsonc`, run `pnpm cf-typegen`: `server/worker-configuration.d.ts` is committed.
- **Vite builds and serves everything** (`vite.config.ts`, Cloudflare Vite plugin). Deploy only `dist/wrangler.json` from a full `pnpm build`: a Worker-only Vite build silently drops `assets`. Wrangler `rules` are ignored by Vite; `.sql` and `.wasm` imports work without them.
- After changing the Better Auth plugin set, regenerate the schema: `pnpm dlx auth@1.7.7 generate --config server/auth.config.ts --output server/src/db/auth-schema.ts` (the `@better-auth/cli` package is stuck at 1.4), then `pnpm db:generate:d1`. `auth migrate` cannot reach D1.

## Ask the owner first

- `wrangler deploy`, `d1 create`, `r2 bucket create`, and remote migrations. `wrangler.jsonc` holds placeholder ids (`TODO(deploy)`).

## Private data

- The test zone, hostnames, Mailgun domain and test mailbox are in `CLAUDE.local.md` (gitignored). Read it before deploying or running end-to-end mail tests.
- **Never put personal addresses, the test domain or account details in tracked files**: code, wrangler config, fixtures, tests, docs or commit messages. Use `example.com`. Deployment-specific wrangler values go in the gitignored `wrangler.local.jsonc` (set `account_id` there).

## Scope guardrails

- Mail over **JMAP only** (RFC 8620, RFC 8621). No CardDAV/CalDAV, no contacts or calendars.
- Build our own frontend, not compatibility layers: no Stalwart endpoints (`/api/auth`, `/api/discover`) or `x:` methods, and **never advertise `urn:stalwart:jmap`**.
- No public signup on any auth method. Better Auth core plaintext-password endpoints stay disabled.
- Outbound mail goes through the provider abstraction. Adding a provider must not touch JMAP or storage code.
- Only Cloudflare products that are GA or in open public beta. Mailgun is the only external service.
- **Never copy Bulwark code (AGPL) into this repo (MIT).** Reading it for reference is fine.

## Workers Free is the target plan

- **10 ms CPU per invocation**, Durable Objects included. Light testing can pass while production fails: measure CPU, don't eyeball it. Gate Paid-only features behind config and say so.
- 128 MB memory: never hold more than one copy of a 25 MiB message. `message.raw` is a single-use stream. Keep `email()` minimal and defer heavy parsing.
- 50 subrequests per invocation. 100k D1 writes/day, so no writes on hot paths.
- Static assets use `not_found_handling: "none"`: only paths with no file reach the Worker, which serves the SPA's index.html and the webmail's deep links (`server/src/assets.ts`). Keep Worker routes in `assets.run_worker_first` anyway, so a file can never shadow them.
- **The server must work without the frontend.** Without the `assets` block there is no `ASSETS` binding and the Worker is API-only: no server code or test may depend on a built SPA or webmail.

## Storage invariants

- The account DO is the **single writer** for its account: all ingest and JMAP writes go through it.
- Message bodies and blobs live in R2, never in SQLite rows. **No mail data in D1.**
- Never hold an SSE response inside a DO (it stays billed for the whole connection). DOs accept WebSockets with the hibernation API.
- Keep DO-specific code behind `AccountStore` (`server/src/store/types.ts`), and R2/D1 access behind similar seams, so a self-hosted adapter stays possible.

## Auth gotchas

- Load Better Auth only through `getAuth(env)` (lazy). `email()`, `/api/health` and the JWT path of `jmapAuth` must not import it. Never wrap one D1 binding in two auth instances.
- `jmapAuth` stays read-only: never call `auth.api.verifyApiKey` (it writes a usage row per call), and never fetch our own `/api/auth/jwks` over HTTP (read the `jwks` table).
- JMAP accepts only JWT access tokens and app passwords. **Every first-party OAuth client must send `resource=<origin>/jmap`**, or it gets an opaque token and a 401.
- App passwords are high-entropy keys: a fast hash, never a KDF per JMAP request.
- Never import `@serenity-kit/opaque`'s default runtime entry on Workers; use `server/src/auth/opaque-runtime.ts`.
- Worker code must lazy-import any module that tests `vi.mock` (e.g. `../send`): the Worker entry is evaluated before the mock applies.
- Factor, recovery and invite behavior must match `docs/account-security.md`.

## JMAP

- `maxSizeAttachmentsPerEmail` is the provider's real limit minus MIME/base64 overhead, and `EmailSubmission/set` enforces the same limit (client checks are advisory).
- What Bulwark expects from the server: `server/src/jmap/README.md`.

## UI (`web/`)

- `docs/design-system.md` is binding.
- English only for now, but every user-visible string goes in the message catalog (`web/src/i18n/en.ts`), never inline.

## Docs

- Research, option comparisons and open questions go in dated files in `docs/research/`. They are not authoritative.
- Decisions go in `README.md` (features), `docs/` (specs) or the module's README (how it's built), not in this file.
- Update a module's README in the same change as its code.
