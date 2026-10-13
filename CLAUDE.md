# s8s-mail

Serverless mail server on Cloudflare. It receives mail with Email Workers, stores it, serves mailboxes over **JMAP**, and sends through pluggable outbound providers. License: MIT.

## Repo layout

pnpm workspace, **flat, with no `apps/` or `packages/` nesting**:
- `server/`: the Worker. JMAP API, Better Auth, `/.well-known/*`, the `email()` handler, Durable Object classes. It serves `../web/dist` as static assets.
- `web/`: the auth/account/admin SPA.
- `shared/`: types and schemas shared between server and web.
- `docs/research/`: dated research notes and open questions. Not authoritative (see "Docs convention").

Commands (run from the repo root; Node 22.22+ and pnpm 11):
- `pnpm install`
- `pnpm dev`: `wrangler dev` on http://localhost:8787 (Worker + `web/dist` assets). For SPA hot reload run `pnpm --filter @s8s/web dev` (Vite, proxies `/api`, `/jmap`, `/.well-known` to :8787).
- `pnpm build`: builds `shared`, then `web` (→ `web/dist`), then a `wrangler deploy --dry-run` of `server`. Deploy is `pnpm --filter @s8s/server deploy`.
- `pnpm lint` (oxlint), `pnpm format` / `pnpm format:check` (oxfmt), `pnpm typecheck`, `pnpm test` (vitest in every package; `server` runs inside workerd via `@cloudflare/vitest-plugin`).
- Per package: `pnpm --filter @s8s/server test`, `pnpm --filter @s8s/web test`, etc.
- Server DB (in `server/`; or `pnpm --filter @s8s/server <script>`):
  - `db:generate:d1`: D1 schema `src/db/schema.ts` → `drizzle/d1/` (applied with `db:migrate:local`, or `wrangler d1 migrations apply DB --remote` at deploy).
  - `db:generate:do`: account-DO schema `src/store/schema.ts` → `drizzle/do/` (run by `AccountDO` on startup).
  - `cf-typegen`: regenerates the committed `worker-configuration.d.ts` after any `wrangler.jsonc` change.
- `wrangler.jsonc` holds placeholder resource ids (`TODO(deploy)`); never run `wrangler d1 create`, `r2 bucket create` or `deploy` without the owner's say-so.

## Stack (decided)

| Concern | Choice |
|---|---|
| Language / packages | TypeScript. **pnpm only** (workspace root = this repo); never npm or yarn. |
| Wrangler | Project-local dev dependency, run as `pnpm wrangler …`. Never install it globally. |
| Server Worker | **Hono** (not Elysia: its Workers adapter is experimental) + Better Auth Hono integration |
| DB access | **Drizzle** for both D1 (`drizzle-orm/d1`) and account DOs (`drizzle-orm/durable-sqlite` + its migrator, run on DO startup). FTS5 virtual tables and triggers may need raw SQL inside Drizzle migrations. |
| Validation | **Zod v4** (already a Better Auth dependency).<br>SPA API routes: `@hono/zod-validator`, with schemas shared via `shared/`.<br>JMAP request envelope: a bad envelope returns `urn:ietf:params:jmap:error:notRequest`.<br>JMAP per-method args: bad args return an `invalidArguments` method error, and the other calls in the request still run. |
| Lint / format | **oxc ecosystem: oxlint + oxfmt** (not Biome, not ESLint/Prettier).<br>oxfmt is pre-1.0, so pin exact versions.<br>Ignore generated files: `worker-configuration.d.ts`, shadcn `components/ui`. |
| SPA (`web/`) | **Vite + React + shadcn/ui** (Tailwind), Better Auth React client. Components from better-auth-ui may be copied in. |

## Product scope (V1, decided)

- Receive mail via Cloudflare Email Routing → Worker `email()` handler, and store it.
- Users access mail **only over JMAP** (RFC 8620 core, RFC 8621 mail). Email only: **no CardDAV/CalDAV, no contacts/calendars JMAP**.
- Organizational/personal deployment: **admins create and remove accounts. No public signup endpoint, ever.**
- Outbound sending through a **provider abstraction**. V1 providers: **Cloudflare Email Sending** and **Mailgun**. On Workers Free, only Mailgun works, because Cloudflare Email Sending needs Workers Paid. Adding a provider must not require touching JMAP or storage code.
  - **The provider is chosen per deployment** (one active provider for the whole install).
  - Advertise its effective limit as a single deployment-wide `maxSizeAttachmentsPerEmail`, minus MIME/base64 overhead, and enforce the same limit in `EmailSubmission/set`.
- **SSO is in V1.** s8s-mail is the OIDC provider for Bulwark and other internal apps.
- **Auth = Better Auth.** Use as much of it as possible.
  - Login methods: **email + password** (Better Auth core, default native scrypt), **passkeys** (`@better-auth/passkey`) and **magic links** (`magicLink()`). Sign-up is disabled on every method.
  - Password login on Workers Free is a **deliberate experiment**: scrypt is measured at 70–170 ms against a 10 ms budget. Instrument and log its CPU time. Passkeys and magic links are the fallback if it fails in practice.
  - `admin()`
  - `@better-auth/oauth-provider` + `jwt()`
  - `@better-auth/api-key` for app passwords. These are random high-entropy keys, so a fast hash is fine; never scrypt per JMAP request.
- **Enrollment and recovery:**
  - The admin creates a user and receives a **one-time invite link** to hand over out of band. The user opens it and registers a passkey.
  - Each user also has an **external recovery address**, set by the admin and stored in D1. Magic links are always sent to that recovery address, **never to the user's own mailbox on this server**, because that would be circular.
  - Losing a passkey or password means a magic link to the recovery address, or a new invite from the admin.
  - Magic-link and invite emails go out through the configured sending provider (Mailgun on Free).
- **Build our own frontend, not backend compatibility layers.** We write the login, consent, password-reset, account and admin pages against Better Auth.
  - Do **not** implement Stalwart-specific endpoints (`/api/auth`, `/api/discover`) or Stalwart `x:` JMAP methods to fit a client.
- **The auth/account/admin frontend is a static SPA** (no SSR).
  - **Bundled:** by default the main Worker serves it via Workers Static Assets.
  - **Headless:** it must also work when deployed separately, with the API base URL set in runtime config, not at build time.
- **No spam filtering in V1.** Email Routing's own SPF/DKIM/DMARC/RBL rejection is the only filter.
- **Address model:**
  - A deployment serves **multiple domains**; each domain is a Cloudflare zone with Email Routing.
  - Each account has one primary address plus **aliases** (other full addresses, any served domain). It receives on all of them, and each is a JMAP Identity it can send as.
  - **Plus-addressing** (`user+tag@`) always routes to `user@`.
  - The address → account mapping lives in D1.
- **Webmail = patched Bulwark Lite**, in our fork [wtarit/s8s-mail-webmail](https://github.com/wtarit/s8s-mail-webmail). It is a separate repo, AGPL-3.0, usually checked out next to this one as `../s8s-mail-webmail/`.
  - The patch enables the OIDC redirect flow for the `static` Lite target.
  - It uses standard `.well-known` discovery and takes the client ID from `config.json`.
  - Scope: `docs/research/2026-10-auth-storage-webmail.md` §5.
- Host everything on Cloudflare. Only outbound delivery (Mailgun) is external.
- Using Cloudflare Email Sending for normal person-to-person mail is accepted. Cloudflare's own agentic-inbox demo does the same.
- Use only Cloudflare products available to the public (GA or open public beta). No private-beta or waitlist features.

## Storage architecture (decided)

**One SQLite-backed Durable Object per JMAP account** holds that account's mail data:
- mailboxes, emails, threads, keywords;
- JMAP state counters and a trigger-maintained change log (for `Foo/changes`);
- full-text search (FTS5).

| Store | Holds |
|---|---|
| Account DO (`idFromName(accountId)`) | All per-account mail data above. The single writer for that account: all ingest and JMAP writes go through it. |
| R2 | Raw `.eml` messages and uploaded blobs, keyed by blobId. Never store message bodies in SQLite rows. |
| D1 (one DB) | Global directory only: Better Auth tables, users → accounts, domains, address → account routing, (later) shared-mailbox grants. **No mail data in D1.** |

- Stateless Worker invocations handle `email()` ingest and the JMAP API. They do auth, R2 I/O and MIME parsing, then call the account DO over RPC.
- **Push:**
  - Bulwark's SSE stream is held by a stateless Worker invocation, which subscribes to the account DO over a WebSocket.
  - The DO accepts that WebSocket with the **hibernation API** (`ctx.acceptWebSocket`).
  - **Never hold an SSE response inside a DO**: it keeps the DO billed for the whole connection.
- A future shared mailbox = its own account (`isPersonal: false`) = its own DO, with grants in D1. Bulwark already shows non-personal session accounts as shared.
- Keep the DO-specific bits behind an `AccountStore` interface (and R2/D1 behind `BlobStore`/`Directory`), so a self-hosted adapter (SQLite file per account) stays possible.
- Why not D1 for mail: D1 has a hard 10 GB per database and is single-threaded. Details in research §7c.

## Platform constraints (verified 2026-10-12, re-check if old)

- **No inbound TCP on Workers** → no own MX, IMAP, POP3 or SMTP submission. Inbound mail arrives only through Email Routing, and clients use JMAP over HTTPS.
- **No outbound port 25** → outbound always goes through a provider's HTTP API.
- Mail domains must be on **Cloudflare DNS**.
- Inbound Email Routing max message: **25 MiB**. `message.raw` is a **single-use stream**.
- Cloudflare Email Sending (public beta, **Workers Paid only**):
  - Message size: **5 MiB total, including attachments**.
  - Recipients: 50 per message (to + cc + bcc).
  - Attachments: up to 32.
  - Headers: custom headers go through an allowlist.
  - Raw RFC 5322 MIME is accepted via `new EmailMessage(from, to, raw)` from `cloudflare:email`.
- Mailgun: 25 MB max message, raw MIME via `POST /v3/{domain}/messages.mime`, separate US/EU API hosts.
- **Target plan: Workers Free** (decided 2026-10-12, as an experiment: build it and see what breaks).
  - Every invocation (`fetch`, `email`, Durable Object request/alarm/WebSocket message) gets **10 ms CPU**. DOs get the same limit as Workers (DO FAQ), so they are no workaround.
  - Cloudflare allows occasional bursts, but sustained overruns are killed. Light testing can therefore pass while production fails intermittently: **measure CPU, don't eyeball it.**
  - Known pressure points:
    - password hashing (kept as an experiment, see Auth);
    - parsing large MIME messages (keep `email()` minimal and defer heavy parsing);
    - building outgoing MIME with attachments;
    - 50 subrequests per invocation.
  - Daily quotas:

    | Resource | Free quota |
    |---|---|
    | Worker requests | 100k / day |
    | D1 rows read | 5M / day |
    | D1 rows written | 100k / day |
    | D1 per database | 500 MB |
    | DO SQLite | 1 GB per object, 5 GB per account |

  - Code should not assume Paid limits. When something can only work on Paid, gate it behind config and say so.
- **Workers Static Assets in SPA mode** answers browser *navigations* with `index.html` without running the Worker.
  - Every path a browser navigates to must be listed in `assets.run_worker_first`: OAuth authorize, `/.well-known/*`, attachment downloads.
  - Otherwise those paths silently return the SPA.
- Workers isolate memory is 128 MB. Do not hold multiple copies of a 25 MiB message in memory.

Sources and full limit tables: `docs/research/2026-10-initial-research.md` §2.

### Better Auth on Workers (verified)

- Needs the `nodejs_compat` flag.
- Create the auth instance **per request**, since bindings are request-scoped.
- **Password hashing:** keep Better Auth's default.
  - `@better-auth/utils` resolves `./password` under the `workerd` export condition to native `node:crypto` scrypt (N=16384).
  - Check the built bundle picks that path, not the pure-JS fallback.
  - Do not use `@node-rs/argon2`; it is a native addon and won't load on Workers. `node:crypto` argon2 is also unsupported.
  - **Never hash passwords with WebCrypto PBKDF2.** Production workerd caps it at **100,000 iterations** on every plan (workerd#1346), below OWASP's 600k.
- App-password / API-key checks must be cheap: random high-entropy keys, never scrypt per JMAP request.
- D1 migrations: `@better-auth/cli generate`, then Drizzle, then `wrangler d1 migrations apply`. `auth migrate` cannot reach D1.
- The JMAP API validates Better Auth JWT access tokens via JWKS. Load the keys directly or via a service binding, not an HTTP self-fetch to the same Worker.

## What Bulwark (the client) expects from our JMAP server

Verified in the Bulwark source (v1.14.2; paths below are relative to `../s8s-mail-webmail/`):
- **Required:** `urn:ietf:params:jmap:core`, `urn:ietf:params:jmap:mail`. Sending needs `urn:ietf:params:jmap:submission`. Attachments need session `uploadUrl`/`downloadUrl`.
- **Optional, feature-detected:** session `eventSourceUrl` (SSE push, polling fallback; no WebSocket), `vacationresponse`, `quota`, `sieve`.
- **Size limits shown to users:** Bulwark reads `maxSizeUpload` (core) and `maxSizeAttachmentsPerEmail` (mail *account* capability) and rejects oversize attachments in the composer with a toast. See `components/email/email-composer.tsx` around line 1695 and `lib/jmap/client.ts` around line 5146.
  - These values must reflect the outbound provider's real limit, minus MIME/base64 overhead.
  - The server must also enforce the limit on submission, because client checks are advisory.
- It also reads `maxCallsInRequest` (default 50) and `maxObjectsInGet` / `maxObjectsInSet` (default 500).
- `urn:stalwart:jmap` gates Bulwark's password, app-password and 2FA screens, which call Stalwart `x:` methods. **We do not implement them, so never advertise that capability.**
- Bulwark has **no** UI for password reset, signup or admin user management.
- Response-shape reference: Bulwark's mock server at `app/api/dev-jmap/[...path]/route.ts`.
- Bulwark is **AGPL**: read its code for reference, **never copy it into this repo** (MIT).

## UI (`web/`)

- **Binding spec: `docs/design-system.md`.** It covers:
  - Bulwark's token values under shadcn/ui token names;
  - the system font stack, Tabler icons, `--radius: 0.75rem`;
  - light and dark via a `.dark` class;
  - the AuthLayout and AppShell templates.
- Default branding, when a deployment sets none: name **"S8S Mail"**, logo is a letter **"S"** mark. Both are overridable via runtime `config.json`.
- **English only** for now, but **every user-visible string lives in one message catalog**: no inline literals in components, so locales can be added later.

## Deployment conventions

- Hostnames per deployment, under the org's primary domain:
  - **`mail.<domain>`**: the main Worker (JMAP API, Better Auth/OIDC issuer, auth/account/admin SPA).
  - **`webmail.<domain>`**: Bulwark Lite on its own Worker.
- Both hostnames are on the same site, so auth cookies stay first-party. JMAP needs CORS for the `webmail.<domain>` origin.

### Test deployment

- The concrete test zone, hostnames, Mailgun domain and test mailbox are in **`CLAUDE.local.md`** (gitignored). Read it before deploying or running end-to-end mail tests.
- **Never put personal addresses, the test domain or account details in tracked files.** That covers code, wrangler config, fixtures, tests, docs and commit messages. Use `example.com` placeholders in tracked files. Deployment-specific wrangler values (routes, custom domains) go in a gitignored config.
- The Mailgun API key is in `.env` as `MAILGUN_API`. It is gitignored: never commit it, print it, or copy it into code or wrangler config. Deploy it with `wrangler secret put`.

## Git and PRs

- Branch from `main`, then open PRs to `main`.

## Docs convention

- This file holds **only decided scope, verified constraints and working conventions**. If a question is not settled, it does not go here.
- Research, option comparisons and open questions go in `docs/research/` as separate dated files.
- When a decision is made, move the conclusion into this file. Mark the research doc's open item as resolved.
- Current open decisions are in `docs/research/2026-10-auth-storage-webmail.md` §7.
