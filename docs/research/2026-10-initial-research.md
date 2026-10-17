# Initial research: serverless JMAP mail on Cloudflare

Date: 2026-10-12. Status: **research only.** Nothing here is a decision unless it also appears in `CLAUDE.md`.

Sources: four research passes (Better Auth/OIDC, Bulwark codebase, Cloudflare platform limits, prior-art projects). The claims marked ✅ were re-checked against primary sources or the code during this session. The rest are from the research passes and should be verified before relying on them.

---

## 1. Feasibility verdict

**Feasible, all on Cloudflare except outbound delivery.** No blocker was found. These constraints shape the design:

| Constraint | Consequence |
|---|---|
| Workers cannot accept inbound TCP ✅ ([docs](https://developers.cloudflare.com/workers/runtime-apis/tcp-sockets/)) | No own MX, no IMAP/POP3, no SMTP submission for clients. Inbound mail arrives only via Email Routing → `email()` handler. Clients must speak **JMAP over HTTPS**. Desktop clients that only speak IMAP (Thunderbird, Apple Mail, Outlook) cannot be supported. |
| Workers cannot open outbound TCP on port 25 | No direct MX delivery. Outbound mail must go through an HTTP sending API: Cloudflare Email Sending, Mailgun, etc. |
| Domain must use Cloudflare DNS for Email Routing / Email Sending | Each mail domain must be a Cloudflare zone. |
| Cloudflare Email Sending is **public beta** (since 2026-04-16) and requires **Workers Paid** ✅ | Fits the "publicly available" requirement, but it is beta. Cloudflare positions it for "transactional" mail. Person-to-person mailbox traffic is a grey area of its intended use. This is a reason Mailgun is a first-class provider, not a fallback. |
| Workers Free gives 10 ms CPU per invocation | Password hashing (scrypt) and parsing large MIME messages will not fit. **Plan for Workers Paid ($5/mo).** It is required for CF sending anyway. |

---

## 2. Cloudflare platform limits (reference)

### Inbound (Email Routing + Email Workers) ✅ ([limits](https://developers.cloudflare.com/email-service/platform/limits/))
- Max inbound message: **25 MiB.** Larger messages are rejected at SMTP time.
- Worker receives `message.from`, `.to`, `.headers`, `.raw` (ReadableStream, **single-use**: buffer or tee it), `.rawSize`; can `setReject(reason)`.
- Catch-all per domain. Subaddressing (`user+tag@`) is an Email Routing setting.
- Limits: 30 Email Routing/Sending domains per zone, 200 routing rules per domain.
- `forward()` only to verified destinations. Irrelevant: we store, we don't forward.
- No spam score or SPF/DKIM/DMARC verdict fields are exposed to the Worker. Cloudflare rejects mail failing the sender's DMARC policy upstream (UNVERIFIED detail). The `Authentication-Results` header in the raw message may be usable (UNVERIFIED).

### Cloudflare Email Sending ✅ ([limits](https://developers.cloudflare.com/email-service/platform/limits/), [Workers API](https://developers.cloudflare.com/email-service/api/send-emails/workers-api/), [pricing](https://developers.cloudflare.com/email-service/platform/pricing/))
- **Total message size 5 MiB including attachments** (25 MiB only to verified destination addresses in the account).
- 50 recipients (to+cc+bcc), 32 attachments, 16 KB custom headers, max 20 non-`X-` custom headers, header allowlist enforced.
- Workers binding `send_email` → `env.EMAIL.send(builder)` (structured) **or** `send(new EmailMessage(from, to, rawMime))` (legacy raw-MIME path, still supported).
  - Raw MIME matters for us: the client builds a full RFC 5322 message, with Message-ID, In-Reply-To, and References. The structured API restricts headers.
  - The raw path's `EmailMessage` takes a single envelope `to`. Multi-recipient semantics on that path are UNVERIFIED.
- REST API and SMTP submission (`smtp.mx.cloudflare.net:465`, beta) also exist.
- Pricing: Workers Paid includes 3,000 emails/month per account, then $0.35/1,000. Daily quota starts "conservative" and is not published.

### Outbound size limits of other providers (for the provider abstraction)

| Provider | Max message incl. attachments | Recipients/msg | Raw MIME |
|---|---|---|---|
| Cloudflare Email Sending ✅ | 5 MiB | 50 | yes (legacy `EmailMessage`) |
| Mailgun | 25 MB | not stated | yes, `POST /v3/{domain}/messages.mime` |
| Amazon SES v2 | 40 MB (after base64) | 50 | yes |
| SendGrid | 30 MB | 1,000 | no (structured) |
| Postmark | 10 MB (UNVERIFIED) | 50 | no |
| Resend | 40 MB (UNVERIFIED) | 50 | no |

Mailgun regions: US `api.mailgun.net`, EU `api.eu.mailgun.net`. API keys and webhooks are regional. Delivery webhooks: `delivered`, `temporary_fail`, `permanent_fail`.

### Storage and runtime

| Service | Relevant limits |
|---|---|
| R2 | 5 GiB single PUT, free egress. Natural home for raw `.eml` blobs and attachments. |
| D1 | 10 GB per DB (Paid), 2 MB max row/blob, FTS5 supported, no interactive transactions (use `batch()`). |
| Durable Objects (SQLite) | GA. 10 GB per object, FTS5 supported, single-threaded per object (natural per-account serialization). |
| KV | Eventually consistent, 1 write/s per key. Not suitable for mailbox state. |
| Queues | 128 KB message. Useful for outbound retry and webhook processing. |
| Workers | 128 MB memory per isolate. A 25 MiB message plus parsed copies is tight: stream to R2 first, parse with bounded memory. |

JMAP push: Bulwark uses the session `eventSourceUrl` (SSE) with a polling fallback, and no WebSocket (see §4). SSE from a Durable Object keeps the object awake. WebSocket hibernation does not apply to SSE. Cost of long-lived SSE connections should be measured.

---

## 3. Auth: is Better Auth a good option?

**Short answer: yes, it is the most complete self-contained option that runs on Workers + D1. We still build the login, consent, and reset pages ourselves.**

- `better-auth` latest **1.7.7** ✅ (npm). Since 1.5 it accepts a D1 binding directly. Create the auth instance per request, because bindings are request-scoped.
- **Password hashing:** the default is scrypt and too CPU-heavy for Workers Free. It can be swapped via `emailAndPassword.password.hash/verify`. A CPU-limit bug on Workers was reported and fixed around v1.5/1.6 (UNVERIFIED which release). Measure on Workers Paid.
- **Admin plugin:** `createUser`, `setUserPassword`, `banUser` (revokes sessions), `removeUser`, `listUsers`, `setRole`, `revokeUserSessions`. Combine with `emailAndPassword.disableSignUp: true` → no public signup surface.
- **Password reset:** `sendResetPassword({user, url, token})` callback; we send the email with our own sending provider and host the reset form ourselves. There is no built-in UI.
- **OIDC provider / SSO for other apps:** use **`@better-auth/oauth-provider`** (npm, latest 1.7.7 ✅), not the deprecated `oidcProvider` plugin.
  - The older plugin had a refresh-token client-secret bypass, CVE-2026-53512, fixed in 1.6.11 (UNVERIFIED details).
  - Features: auth code + PKCE S256, refresh tokens with rotation, client_credentials, device code, dynamic client registration, `/.well-known/openid-configuration` and `/.well-known/oauth-authorization-server`, JWKS via the `jwt()` plugin, trusted clients that skip consent.
  - **We must build the `loginPage` and `consentPage`.**
  - With this plugin, s8s-mail can be the IdP for other apps the way Stalwart is.
- **JMAP clients and Basic auth:** RFC 8620 §8.2 discourages Basic but recommends per-client app passwords. Most native JMAP and mobile clients still use Basic.
  - Plan a custom Basic-auth middleware using **app passwords**: random high-entropy tokens stored as SHA-256 hashes, not scrypt, so per-request verification is cheap.
  - Better Auth's `bearer()` and `apiKey()` plugins can back this, but neither speaks HTTP Basic natively.
- **Alternatives considered:**
  - Lucia: deprecated.
  - Auth.js: maintenance-only, now under Better Auth.
  - OpenAuth (SST): beta, low activity.
  - `cloudflare/workers-oauth-provider`: an active, lower-level OAuth 2.1 framework. We would still build all user/credential management.
- **Known risk:** Better Auth issue #11329 reports that Email-OTP sign-in can delete the credential accounts of admin-provisioned users. Avoid the email-OTP plugin until it is confirmed fixed.

Stalwart for comparison: a built-in OAuth server (`/.well-known/oauth-authorization-server`, `/auth/token`, device flow, RFC 7591 registration). It also directs IMAP-only clients to app passwords.

---

## 4. Bulwark webmail (`s8s-mail-webmail/`, v1.14.2, Next.js 16, **AGPL-3.0-only** ✅)

### 4.1 Can Bulwark be hosted on Cloudflare as a separate Worker?

There are two editions in one tree:

1. **Bulwark Lite (static export) — yes, a clean fit.** ✅
   - `npm run build:lite` sets `output: "export"` (`s8s-mail-webmail/next.config.ts:43-51`) and removes `proxy.ts`, `app/api`, admin, and setup.
   - The browser talks to the JMAP server directly. Deploy as **Workers Static Assets** (SPA fallback).
   - Runtime config comes from a static `config.json` next to `index.html`.
   - Our JMAP server must send CORS headers for the webmail origin unless both are served from the same origin.
   - Lite **loses**: admin console, plugins, settings sync, cookie-backed features.
   - Lite has two build targets (`s8s-mail-webmail/lib/lite.ts`):
     - `static`: any static host.
     - `stalwart`: served same-origin by Stalwart, with an unknown-path → `index.html` rewrite and `<base href>` injection.
2. **Full edition (`output: "standalone"`, Node server) — not recommended on Workers.** Blockers:
   - Server state is on the filesystem in about 27 modules: config, audit log, settings sync, plugin registry, branding uploads, admin password.
   - `sharp` (native).
   - DNS-level SSRF guard via `node:dns` + undici `Agent`.
   - Scheduled jobs in `instrumentation.node.ts`.
   - `proxy.ts` pinned to the Node runtime.
   - Porting via `@opennextjs/cloudflare` (latest 1.20.10) would mean replacing all fs state with D1/KV/R2, effectively a fork.

### 4.2 Auth in Bulwark (what our server must provide)

- **Basic** (default): the browser sends `Authorization: Basic` straight to the JMAP server.
- **Lite password login**, verified in `s8s-mail-webmail/lib/auth/lite-tokens.ts` ✅:
  - Tries Stalwart's structured login first: `POST <server>/api/auth` (password, MFA, PKCE challenge) → code, then `POST <server>/auth/token` → access + refresh tokens. These are kept in localStorage or sessionStorage ("remember me").
  - **Servers without `/api/auth` fall back to Basic**, and that session only survives a reload within the same tab.
- **Lite OAuth/SSO redirect flow is only enabled for the `stalwart` target**: `LITE_OAUTH_AVAILABLE = IS_LITE_STALWART` (`s8s-mail-webmail/lib/auth/lite-oauth.ts:28`) ✅.
  - It discovers via `GET <server>/api/discover/<account>`, a Stalwart endpoint, then does PKCE in the browser.
  - The `static` Lite target therefore has **no SSO button**.
- **Full edition OIDC**: generic.
  - Env: `OAUTH_ENABLED`, `OAUTH_ISSUER_URL`, `OAUTH_CLIENT_ID`/`SECRET`, `OAUTH_SCOPES`.
  - Discovery: `/.well-known/oauth-authorization-server`, then `/.well-known/openid-configuration` ✅ (`s8s-mail-webmail/lib/oauth/discovery.ts:157`). PKCE S256, refresh token in an httpOnly cookie, Bearer to JMAP.
  - Default scope is `openid email profile`; `offline_access` must be added explicitly.

**Options for SSO with Lite** (open decision, see §7):
- (a) Implement Stalwart-compatible `/api/auth` + `/auth/token` + `/api/discover/<account>` in s8s-mail and serve the Lite `stalwart` target same-origin from our Worker.
- (b) Patch the Bulwark fork so the `static` target can use generic OIDC discovery.
- (c) Ship Basic/app-password login only in V1.

### 4.3 Password reset, account creation, admin

| Feature | In Bulwark? | Backing API |
|---|---|---|
| Forgot / reset password | **No** | none |
| Sign-up / account creation | **No** | none |
| Admin user management (create/remove users) | **No** (read-only `x:Account/get` only) | none |
| Change own password | Yes | `x:AccountPassword/set` (Stalwart JMAP extension) |
| App passwords | Yes | `x:AppPassword/query/get/set` |
| API keys | Yes | `x:ApiKey/*` |
| TOTP 2FA | Yes | `x:AccountPassword/set` with `otpAuth` |
| Display name | Yes | `x:AccountSettings/get/set` |

- All "Yes" screens are gated on the session advertising the `urn:stalwart:jmap` capability and the passthrough flag (`s8s-mail-webmail/stores/account-security-store.ts:335-339`). On a non-Stalwart server they are hidden.
- In Lite, `stalwartJmap()` returns 404 (`s8s-mail-webmail/lib/stalwart/jmap-passthrough.ts:41-45`), so these screens need the full edition or a patch.
- **Conclusion:** we must build our own surface for admin user management, password reset, and (if SSO) login/consent. Self-service password change, app passwords, and 2FA are either reimplemented as Stalwart-compatible `x:` methods (to reuse Bulwark UI) or provided on our own account pages.

### 4.4 Attachments and per-provider size limits ✅

Bulwark reads limits from the JMAP session and refuses oversize files **before uploading**, with a toast:
- `maxSizeUpload` (core capability), checked per file → toast `attachment_too_large` (`s8s-mail-webmail/components/email/email-composer.tsx:1697-1704`).
- `maxSizeAttachmentsPerEmail` (mail **account** capability, `s8s-mail-webmail/lib/jmap/client.ts:5146`), checked against the running total → toast `attachments_total_too_large` (`email-composer.tsx:1705-1717`). Oversize files are dropped and the rest are kept.
- If a value is absent or 0, there is no client check.
- Upload is a raw POST to the session `uploadUrl`. There are no large-file link features.

**Implication:** the user is informed via `maxSizeAttachmentsPerEmail`, which is per JMAP *account*, not per identity or provider. The server should:
1. Advertise `maxSizeAttachmentsPerEmail` for each account derived from that account's effective sending provider. Subtract MIME/base64 overhead: about 4/3 expansion plus headers and body. Cloudflare's 5 MiB total leaves roughly **3.5 MiB** of raw attachments; Mailgun's 25 MB leaves roughly 18 MB.
2. Also enforce the limit server-side in `EmailSubmission/set`, returning a JMAP `tooLarge` SetError. Bulwark's check is advisory and other clients may not check at all.
3. If one account can send through several providers (per identity or per domain), advertise the **minimum**, or route oversize messages to the larger-capacity provider. This is an open decision.

### 4.5 JMAP surface Bulwark expects

| Capability | Needed? |
|---|---|
| `urn:ietf:params:jmap:core` | required. Also reads `maxSizeUpload`, `maxCallsInRequest` (default 50), `maxObjectsInGet`/`Set` (default 500). |
| `urn:ietf:params:jmap:mail` | required (`connect()` fails without a mail account) |
| `urn:ietf:params:jmap:submission` | needed to send |
| session `uploadUrl` / `downloadUrl` | needed for attachments |
| session `eventSourceUrl` | optional (live updates via SSE; polling fallback) |
| `vacationresponse`, `quota`, `sieve` | optional, feature-detected |
| `contacts`, `calendars`, `principals`, `filenode`, `mail:share`, `emailpush` | optional, feature-detected; out of scope |
| `urn:stalwart:jmap` | optional; **do not advertise unless the `x:` methods are implemented** |

Bulwark contains a ~2,500-line mock JMAP server at `s8s-mail-webmail/app/api/dev-jmap/[...path]/route.ts`, a useful reference for the response shapes it expects. **AGPL: read for reference, do not copy code into s8s-mail (MIT).**

---

## 5. Prior art on Cloudflare

| Project | Notes |
|---|---|
| [cloudflare/agentic-inbox](https://github.com/cloudflare/agentic-inbox) (Apache-2.0) | Workers + **one Durable Object (SQLite) per mailbox** + R2 attachments + Email Routing + `send_email`. Auth via Cloudflare Access, with **no per-mailbox authorization** (anyone past Access sees all mailboxes); we must not repeat this. No JMAP. |
| [osranze/mailx](https://github.com/osranze/mailx) (CC0, experimental) | Closest prior art: partial JMAP on Workers. Raw `.eml` in R2 at `emails/{accountId}/{emailId}.eml` with `blobId = emailId`, metadata in D1, attachments re-parsed from raw on download. Gaps: no push, no `/changes`-quality state, no quotas, naive search, Resend only, no retry queue. |
| genisis-lab/mail "Wren" (PR #10, 2026-10) | DO + SQLite + R2. JMAP added with **SQLite triggers writing a `jmap_changes` log**: the pattern for incremental `Foo/changes`. |
| trishtzy/mailflare (issue #6) | Pitfall: no incremental `/changes` forces full re-sync and slow clients. |
| dreamhunter2333/cloudflare_temp_email (MIT, ~12k★) | D1-centric temp mail, IMAP only via an external Python proxy. Not a model for us. |
| maillab/cloud-mail (MIT, ~15k★) | Hono + Drizzle + D1 + R2, Resend only, custom API. |

### Libraries
- **postal-mime** 4.0.5 ✅: MIME parsing, works in Workers. Holds the whole message in memory, so bound input size. Output is unsanitized.
- **MIME building:** `mimetext` (used in CF docs; one report of a Workers breakage, UNVERIFIED). Alternatively build raw MIME ourselves.
- **JMAP types:** `jmap-jam` (typed client, RFC 8620/8621 types). There is no server-side TypeScript JMAP library; dispatch and state logic are hand-written.
- **Search:** FTS5 is available in both D1 and DO SQLite. D1 export fails with virtual tables present.

---

## 6. Recommendations (not yet decided)

1. **Storage:** one Durable Object (SQLite) per JMAP account for mailbox, email, thread, and state with a trigger-maintained change log. Raw messages and blobs go in R2 keyed by blobId. D1 holds the global directory: users, domains, address→account routing, auth tables.
2. **Auth:** Better Auth on D1 with `disableSignUp` and the admin plugin. App passwords via Basic for JMAP clients. Add `@better-auth/oauth-provider` when SSO is needed. Minimal server-rendered pages in s8s-mail: login, consent, reset password, admin user list.
3. **Webmail:** Bulwark Lite on Workers Static Assets as its own Worker. Decide between SSO options (a)/(b)/(c) in §4.2.
4. **Sending:** a `SendProvider` interface taking raw MIME plus envelope and exposing `maxMessageBytes`. V1 implementations are Cloudflare (`EmailMessage` raw path) and Mailgun (`messages.mime`). Use a queue for retries; Mailgun webhooks feed delivery status.
   - **Resolved 2026-10-17:** Cloudflare Email Sending support was dropped. Mailgun is the only V1 provider; the `SendProvider` abstraction stays for future providers.
5. **Plan:** Workers Paid.

## 7. Open decisions

Continued in `2026-10-auth-storage-webmail.md` §7.

- [ ] Storage layout: per-account DO vs. D1-centric.
- [x] Auth library: **Better Auth**, using as much of it as possible (see CLAUDE.md).
- [x] Bulwark SSO path: **no backend compatibility layer**. SSO is required in V1. Remaining choice: patch Bulwark Lite vs. another client (follow-up doc §5).
- [x] Stalwart `x:` methods: **not implemented**. We build our own account pages on Better Auth.
- [x] Provider selection: **per deployment**, so `maxSizeAttachmentsPerEmail` is one deployment-wide value.
- [x] Admin surface: our own web frontend (Better Auth admin plugin). The exact layout is still open.
- [x] Spam handling: **none in V1**. Options are in follow-up doc §6.
- [x] Cloudflare's "transactional" positioning of Email Sending: **accepted** for person-to-person mail. Moot since 2026-10-17: Cloudflare Email Sending support was dropped; Mailgun is the only V1 provider (CLAUDE.md).
- [x] Webmail and JMAP deployment: `webmail.<domain>` + `mail.<domain>`, same site, with CORS on JMAP (CLAUDE.md).
