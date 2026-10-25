# s8s-mail
S(erveles)s Mail - Email server on Cloudflare worker.

## Background
I want a low (or ideally no) maintenance email server that has $0 running cost. It needs to be usable on the Cloudflare Workers free tier, because for Workers Paid the minimum is $5, and at that price you can get a VPS and run [mail-in-a-box](https://mailinabox.email/) or [stalwart](https://stalw.art/).

## Features

**Mail**
- Receives mail through Cloudflare Email Routing (Worker `email()` handler).
- Mailboxes are served over **JMAP only** (RFC 8620 core, RFC 8621 mail). Email only: no CardDAV/CalDAV.
- Outbound goes through a pluggable provider. V1 ships Mailgun (HTTP API), one active provider per deployment (see [Considerations in choosing an outbound email provider](docs/email-sending-provider.md) for full details).

**Accounts and addresses**
- Multi-user. Admins create accounts and hand over an invite link; there is no public signup.
- Multiple domains. An account has a primary address plus aliases on any served domain, and each alias is a JMAP Identity it can send as.
- Plus-addressing (`user+tag@`) routes to the base user. A domain can have an optional catch-all.

**Sign-in**
- Passkeys and passwords (OPAQUE, so the server never sees the password). A user can have both, which makes them a 2FA user.
- Recovery by magic link, sent to an external recovery address. See [docs/account-security.md](docs/account-security.md).
- App passwords for JMAP Basic auth (mail clients that cannot do OAuth).
- s8s-mail is the OIDC provider (SSO) for the webmail and other internal apps.

**Frontends**
- The auth/account/admin SPA is a static bundle. By default the main Worker serves it; it can also be deployed headless, with the API base URL set in a runtime `config.json`.
- Webmail is Bulwark Lite, patched to sign in through OIDC, in our fork [wtarit/s8s-mail-webmail](https://github.com/wtarit/s8s-mail-webmail) (see the note at the top of its README). `pnpm dev` and `pnpm build` download the release pinned in `web/webmail.json` into the gitignored `web/public/webmail/` (the build copies it into `web/dist/webmail/`), and the Worker serves it at `/webmail/`, with its `config.json` generated from the Worker's vars.
- Both are optional: without the `assets` block in `wrangler.jsonc`, the Worker is API-only.

## Architecture

```
wrangler.jsonc  the one Worker config (tracked placeholders; real values in wrangler.local.jsonc)
server/         the Worker: JMAP API, Better Auth, /.well-known/*, email() handler, Durable Object classes
web/            auth/account/admin SPA, plus the webmail download (served by the Worker from web/dist)
shared/         types and schemas shared by server and web, imported as `#shared`
docs/           deploy guide, design system, account security spec
docs/research/  dated research notes. Not authoritative.
```

One package (one `package.json`, one `node_modules`), three source folders, built by one Vite config (`vite.config.ts`, with the Cloudflare Vite plugin): `vite build` bundles the SPA and the Worker together (Rolldown, minified, lazy imports as separate modules). Each folder has its own `tsconfig.json` (Worker types vs DOM) and its own vitest project (workerd, jsdom, Node). oxlint forbids imports across folders: `server/` and `web/` share code only through `#shared`, and `server/` never imports `web/`.

Module internals live in the READMEs under `server/src/` (`auth`, `jmap`, `mail`, `db`, `store`).

| Store | Holds |
|---|---|
| Account DO (one SQLite Durable Object per JMAP account, `idFromName(accountId)`) | Mailboxes, emails, threads, keywords, JMAP state counters, a trigger-maintained change log, FTS5 search. The single writer for that account. |
| R2 | Raw `.eml` messages and uploaded blobs, keyed by blobId. No message bodies in SQLite rows. |
| D1 (one database) | The global directory only: Better Auth tables, users to accounts, domains, address to account routing, invites, later shared-mailbox grants. **No mail data.** |

- Stateless Worker invocations handle `email()` ingest and the JMAP API. They do auth, R2 I/O and MIME parsing, then call the account DO over RPC.
- **Push** is an SSE stream held by a stateless Worker invocation. That invocation subscribes to the account DO over a WebSocket, which the DO accepts with the hibernation API. An SSE response is never held inside a DO, because that bills the DO for the whole connection.
- A future shared mailbox is its own account (`isPersonal: false`), so its own DO, with grants in D1.
- DO-specific code sits behind an `AccountStore` interface, so a self-hosted adapter stays possible.

**Hostnames.** A deployment uses one hostname, `mail.<domain>`, for JMAP, the OIDC issuer, the SPA and the webmail (`/webmail/`). The root goes to the webmail (the SPA's `config.json` sets `webmailUrl`; without it, `/` opens the account). Everything is same-origin, so there is no CORS, and signing in to the webmail reuses the account session.

## Tech stack

- TypeScript, one pnpm package with `server/`, `web/` and `shared/` folders.
- Server: Cloudflare Workers, [Hono](https://hono.dev), [Better Auth](https://better-auth.com) (passkey, OAuth provider, API key, admin, magic link, plus our OPAQUE plugin).
- Data: Drizzle ORM for D1 and for the account DOs (`drizzle-orm/durable-sqlite`).
- Validation: Zod v4, with `@hono/zod-validator` on SPA API routes.
- SPA: Vite, React, shadcn/ui (Tailwind). See [docs/design-system.md](docs/design-system.md).
- Build: Vite 8 with `@cloudflare/vite-plugin` for both the SPA and the Worker.
- Tooling: oxlint and oxfmt, vitest (the server suite runs inside workerd).

## Development

Run from the repo root. Needs Node 24+ and pnpm 12. To use a custom `wrangler.jsonc`, you set `S8S_WRANGLER_CONFIG` environment variable pointing to your custom config file. (e.g. `S8S_WRANGLER_CONFIG=wrangler.local.jsonc pnpm build`)

```bash
pnpm install
pnpm dev                 # vite dev on http://localhost:8787: SPA with hot reload, the Worker in workerd, the webmail
pnpm build               # typecheck, webmail, then vite build (web/dist + dist/)
pnpm preview             # the built app on :8787
pnpm lint                # oxlint
pnpm format              # oxfmt  (pnpm format:check to verify only)
pnpm typecheck           # one tsc per folder
pnpm test                # vitest: server (workerd), web (jsdom), shared projects
pnpm coverage            # istanbul; per-folder thresholds fail the run on regression
pnpm test --project server   # one project (also web, shared)
pnpm wrangler <command>  # any wrangler command; it reads ./wrangler.jsonc and ./.dev.vars
```

Database and config scripts, also run from the root:

- `db:generate:d1`: D1 schema `server/src/db/schema.ts` to `server/drizzle/d1/`. Apply with `db:migrate:local`, or `wrangler d1 migrations apply DB --remote` at deploy.
- `db:generate:do`: account-DO schema `server/src/store/schema.ts` to `server/drizzle/do/`. `AccountDO` applies it on startup.
- `cf-typegen`: regenerates the committed `server/worker-configuration.d.ts`. Run it after any `wrangler.jsonc` change.
- `opaque:setup`: creates `OPAQUE_SERVER_SETUP` in the ignored `.dev.vars`. Run once; see `server/src/auth/README.md`.
- Better Auth schema: when the plugin set changes, regenerate `server/src/db/auth-schema.ts` with `pnpm dlx auth@1.7.7 generate --config server/auth.config.ts --output server/src/db/auth-schema.ts`, then `pnpm db:generate:d1`. The `@better-auth/cli` package is stuck at 1.4 and `auth migrate` cannot reach D1.

Local D1, DO and R2 data live in `.wrangler/state` for both `pnpm dev` and `pnpm preview`. The build also copies the secrets from `.dev.vars` to `dist/.dev.vars` (mode 0600) for `vite preview`; `wrangler deploy` does not upload it.

The webmail download is cached in `node_modules/.cache/s8s-webmail`, and `pnpm webmail` only re-extracts it when the pinned version changes. `WEBMAIL_ZIP=/path/to.zip` uses a local Lite build instead, and `WEBMAIL_SKIP=1` removes it (`/webmail/` then serves a 404). To update it, change `version` and `sha256` in `web/webmail.json` (the `.sha256` file next to the release zip).

`wrangler.jsonc` holds placeholder resource ids. For a real deployment see [docs/deploy.md](docs/deploy.md).

## Limits and compromises

- **Targets Workers Free.** Every invocation gets 10 ms CPU (Durable Object requests, alarms and WebSocket messages too), 128 MB memory and 50 subrequests. Light testing can pass while sustained load gets invocations killed, so measure CPU. Limit tables: [docs/research/2026-10-initial-research.md](docs/research/2026-10-initial-research.md) §2.
- **25 MiB inbound maximum** (Email Routing). Mailgun accepts 25 MB per message, so the advertised `maxSizeAttachmentsPerEmail` is that limit minus MIME/base64 overhead, and `EmailSubmission/set` enforces it.
- **No spam filtering.** Email Routing's SPF/DKIM/DMARC/RBL rejection is the only filter.
- **Password length is enforced in the browser only.** An OPAQUE server never sees the password, so it cannot check it.
- **CPU fit on Free is not proven end to end.** The OPAQUE server operations fit the budget in an isolated probe. Large-MIME parsing and outgoing MIME with attachments still need measuring on a deployment.
