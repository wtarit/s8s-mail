JMAP API (RFC 8620 core, RFC 8621 mail + submission): session, methods, upload/download, event source.

## Mounting

```ts
import { jmapApp, wellKnownJmap } from "./jmap";

app.get("/.well-known/jmap", wellKnownJmap); // 302 -> /jmap/session
app.use("/jmap/*", jmapAuth); // sets c.var.principal = { userId, email, accountIds }
app.route("/jmap", jmapApp);
```

Routes: `GET /session`, `POST /api`, `POST /upload/:accountId/`, `GET /download/:accountId/:blobId/:name?type=`, `GET /eventsource?types=&closeafter=&ping=`. Every route trusts `c.var.principal`; any `accountId` outside `principal.accountIds` is `accountNotFound` (API) or 404 (blobs).

## Layout

- `api.ts` request envelope (Zod, `notJSON`/`notRequest`/`unknownCapability`/`limit` request errors), sequential dispatch, `createdIds`. `references.ts` result references (`#prop`, JSON Pointer with `*`).
- `methods/*.ts` one file per type. Handlers validate with Zod and throw `MethodError` (`invalidArguments`, ...); the other calls of the request still run. `registry.ts` has the handler type; `MultiResponse` lets a handler answer with implicit extra responses (EmailSubmission/set -> Email/set).
- `context.ts` per-request state (created ids, D1 directory lookups, subrequest budget).
- `session.ts`, `blobs.ts`, `eventsource.ts`, `rawheaders.ts` (header block parsing for `headers`/`header:*` and Email/import).
- The account DO is reached only through typed RPC (`AccountDO` methods in `../store/account-do.ts`, SQL in `../store/jmap-store.ts`, filter/sort compilation in `../store/jmap-filter.ts`).

## Methods

Implemented: `Core/echo`; `Mailbox/get|changes|query|set`; `Thread/get|changes`; `Email/get|changes|query|set|import`; `SearchSnippet/get`; `Identity/get|set`; `EmailSubmission/get|changes|query|set`.

Answered with `cannotCalculateChanges`: `Mailbox/queryChanges`, `Email/queryChanges`, `EmailSubmission/queryChanges`, `Identity/changes` (clients re-run the query). `Email/query` returns `canCalculateChanges: false`.

Partial / deliberate limits:
- `Email/query` sort `subject` is a plain case-insensitive compare (no RFC 5256 base-subject stripping); `text`/`body` use FTS5 (unicode61): whole words and `prefix*`, no stemming, no Thai/CJK word segmentation. `header` filter only knows the headers stored as columns (subject, from, to, cc, bcc, reply-to, sender, message-id, in-reply-to, references). Dates filter on `receivedAt`.
- `Email/get`: `sentAt` is returned in UTC (the original offset is not stored). `bodyStructure` is the synthesized tree from `store/parse.ts`; part `headers` is `[]`. `headers` and `header:*` read the first 64 KiB of the raw message from R2.
- `Email/set` create takes `textBody`/`htmlBody`/`attachments`/`bodyValues` (no `bodyStructure`), extra headers via `headers` or `header:Name:asText|asRaw|asAddresses`. Update accepts only `keywords` and `mailboxIds` (whole value or patch paths). Keywords are stored lower-case.
- `Mailbox/set`: system roles cannot be destroyed or re-roled; no `filterAsTree`/`sortAsTree`.
- `Identity/set`: update `name`, `replyTo`, `bcc`, `textSignature`, `htmlSignature` only; create/destroy are `forbidden` (addresses and aliases are managed by the admin in D1). The Identity id is `i` + 24 hex of SHA-256(address).
- Not enforced: `maxConcurrentRequests` / `maxConcurrentUpload` (advertised only; the Worker is stateless).

## Client compatibility: Bulwark

What the webmail client expects from this server. Verified against Bulwark v1.14.2; paths are relative to `s8s-mail-webmail/`. Read Bulwark for reference only and never copy its code here (AGPL vs MIT).

- **Required:** `urn:ietf:params:jmap:core` and `urn:ietf:params:jmap:mail`. Sending needs `urn:ietf:params:jmap:submission`. Attachments need the session `uploadUrl` and `downloadUrl`.
- **Optional, feature-detected:** session `eventSourceUrl` (SSE push with a polling fallback; Bulwark does not use WebSocket), `vacationresponse`, `quota`, `sieve`.
- **Size limits shown to users:** Bulwark reads `maxSizeUpload` (core) and `maxSizeAttachmentsPerEmail` (mail *account* capability) and rejects oversize attachments in the composer with a toast (`components/email/email-composer.tsx` around line 1695, `lib/jmap/client.ts` around line 5146). Both values must reflect the outbound provider's real limit minus MIME/base64 overhead. The server enforces the same limit on submission, because client checks are advisory.
- It also reads `maxCallsInRequest` (default 50) and `maxObjectsInGet` / `maxObjectsInSet` (default 500).
- **Never advertise `urn:stalwart:jmap`.** It gates Bulwark's password, app-password and 2FA screens, which call Stalwart `x:` methods we do not implement.
- Bulwark has **no** UI for password reset, signup or admin user management. The SPA in `web/` covers those.
- Response-shape reference: Bulwark's mock server at `app/api/dev-jmap/[...path]/route.ts`.

## Decisions

- **Unparsed messages.** `Email/get` on a `pending`/`failed` row (the DO alarm has not produced bodies yet): body properties are parsed on demand inside the request for raw messages up to 128 KiB, at most 3 per request, not persisted. Otherwise the response carries a placeholder `textBody` and `bodyValues` with `isTruncated: true`, which Bulwark answers by refetching. List-style properties (`preview`, `hasAttachment`) are whatever the DO stored (`""`/false until parsed). Downloading a part blob that is missing in R2 re-parses the raw message (up to 1 MiB).
- **R2 read budget.** Body values and header reads draw from `MethodContext.r2Budget` (30 R2 reads per HTTP request); when it is spent, remaining body values come back `isTruncated: true` with an empty value and `headers` as `[]`, so the client refetches in a new request.
- **Sending is synchronous.** `EmailSubmission/set` loads the raw message, strips Bcc, calls `provider.send` inside the request and records the submission as `undoStatus: "final"`. There is no queue, retry or undo/delay (`maxDelayedSend: 0`): a retryable provider failure (429, 5xx, network) becomes a `serverFail` SetError and the client resends. Non-retryable failures map to `tooLarge`, `tooManyRecipients`, `noRecipients`, `invalidEmail` (HTTP 400/422), `forbiddenToSend` (everything else). Checks before sending: From must equal the identity address (`forbiddenFrom`), MAIL FROM must be one of the account's addresses (`forbiddenMailFrom`), message size and total attachment bytes against the provider limit (`tooLarge`).
- **Limits.** `maxSizeUpload` and `maxSizeAttachmentsPerEmail` are both `maxAttachmentBytes(getSendProvider(env))`; upload, Email/set create (per message) and submission enforce it. `deliveryStatus` after a successful provider call is `delivered: "queued"` (delivery results are not tracked).
- **Downloads** are always `Content-Disposition: attachment` with `nosniff` and a sandbox CSP, since attachment bytes are untrusted on the app origin.

## CPU hot paths

`buildMime` with attachments (base64 of the whole payload) in `Email/set` create; `removeBccHeader` + copying the raw message in `EmailSubmission/set`; the on-demand postal-mime parse in `Email/get`; part re-parse in downloads; `Email/query` with `collapseThreads` or keyword sorts on big mailboxes (SQLite work in the DO, correlated subqueries); `Mailbox/get` counts (4 subqueries per mailbox).
