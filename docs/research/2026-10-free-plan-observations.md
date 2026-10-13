# Workers Free experiment: first observations

Date: 2026-10-13. First live test of the test deployment on Workers Free (10 ms CPU per invocation). Source: `wrangler tail --format json` over ~5 minutes while one user had Bulwark open, plus 3 inbound test messages. A small sample: treat as indicative only.

| Invocation | n | median CPU | max CPU | over 10 ms |
|---|---|---|---|---|
| `email()` ingest (incl. one rejected recipient) | 3 | 6 ms | 7 ms | 0 |
| `POST /jmap/api` | 14 | 8 ms | **111 ms** | 1 |
| Other (DO RPC, parse alarm, push) | 14 | 0 ms | 10 ms | 0 |

All invocations completed `ok`; the 111 ms request was not killed (burst allowance).

## Findings

- **Ingest is fine** on Free for small messages: header-only parsing in `email()` plus the deferred DO parse alarm keep each invocation under budget.
- **JMAP API requests sit right at the limit (median 8 ms).** A request also pays for auth (Bearer token lookup or API-key check) and JSON work. Sustained traffic near 10 ms risks intermittent kills once the burst allowance runs out.
- One JMAP request took **111 ms**. It is probably `Email/get`'s on-demand MIME parse (≤128 KiB raw), or a large response. It needs per-method attribution.

## Per-method attribution (2026-10-13, no code changes)

Method: one JMAP method per request, tagged `?probe=<name>`, 5 rounds against the deployed Worker; `cpuTime` and `wallTime` from `wrangler tail --format json`. The tail sampled 36 of 55 requests. Account had 3 emails.

| Probe | Auth | CPU median (min–max) | Wall median |
|---|---|---|---|
| `Core/echo` | Basic (app password) | 2.5 ms (2–3) | 56 ms |
| `Core/echo` | **Bearer (OAuth, what Bulwark uses)** | **8 ms (6–9)** | **163 ms** |
| `GET /jmap/session` | Basic | 3 ms | 81 ms |
| `GET /jmap/session` | Bearer | 7 ms (6–10) | 184 ms |
| `Mailbox/get` | Basic | 3 ms | 77 ms |
| `Email/query` (collapseThreads, total) | Basic | 3 ms | 62 ms |
| `Email/get` list props | Basic | 3 ms | 69 ms |
| `Email/get` body props + bodyValues | Basic | 4 ms | 135 ms |
| `Thread/get`, `Identity/get`, `Email/changes` | Basic | 2–3 ms | 64–77 ms |
| DO-side invocations (RPC, alarms) | — | 0 ms median, 15 ms max | — |

**Finding: auth, not JMAP, dominates.** The methods themselves cost 0–2 ms on top of a ~2 ms baseline. **Bearer auth adds ~5–6 ms CPU and ~100 ms wall per request**, so Bulwark traffic sits at 7–10 ms where Basic sits at 2–4 ms.

The Bearer path (`server/src/auth/jmap-auth.ts`, `userIdFromOpaqueToken`) per request:
1. Hashes the token and looks it up in D1 (`oauth_access_token`).
2. Checks the client is trusted (D1).
3. Calls `auth.api.oauth2UserInfo(...)` for the provider's own validation. That runs the full Better Auth endpoint pipeline in-process, plus further D1 reads (token, user, session).
4. Loads the user and builds the principal (D1).

Hypotheses to confirm with a CPU flamegraph (`cf workers versions profile`):
- **H1:** the `oauth2UserInfo` call (Better Auth context/hook pipeline + validation) is the ~5 ms. The extra D1 round trips explain the ~100 ms wall.
- **H2:** `createAuth`'s per-`env` `WeakMap` cache misses, if `env` isn't the same object across requests, so `makeAuth` (plugin/schema construction) runs per request.
- **H3:** the 111 ms outlier in the first sample is the lazy `import("./auth")` evaluating Better Auth on the first Bearer request in a fresh isolate (cold start landing on a request).

## CPU profile of the Bearer auth path (2026-10-13)

**Production capture failed.** `cf workers versions profile` (logged in, valid token) returned `[10393] No recent executions were found for this Worker` on every attempt, including with exact version ids and ~2 min of sustained Bearer traffic. The cause is unknown (plan/feature availability?); the docs only say "send traffic and retry".

**Local capture instead.** Setup:
- `wrangler dev` with a fresh local D1 and a throwaway admin.
- V8 sampling profiler (50 µs) through the dev inspector. The inspector needs an `Origin` header.
- 300 × `Core/echo` per auth mode.

Local absolute numbers include dev-only overhead (wrangler facade middleware, tracing, local D1 simulation), so production is roughly 0.35–0.4× local. The **ratio** matches production (Bearer ≈ 2.5–3× Basic).

| Mode | Busy JS per request (local) | Production `cpuTime` |
|---|---|---|
| Basic (app password) | 7.8 ms | ~2.5 ms |
| Bearer (OAuth, Bulwark) | 19.2 ms | ~8 ms |

Where the Bearer path's extra time goes (local ms/request, inclusive, overlapping):

| Function (bundle → source) | ms | What it is |
|---|---|---|
| `findOne` / `transformOutput` in `@better-auth/core/dist/db/adapter/factory.mjs` | 4.1 / 2.3 | Better Auth's generic adapter, called from `auth.api.oauth2UserInfo` (token, client, user, session reads) |
| ↳ `formatTransactionId` → `getColorDepth` → `getEnvVar` (`@better-auth/core` `env/color-depth.mjs`, `env/env-impl.mjs`) | 1.0 / 0.9 / 0.7 | **Debug-log strings are formatted eagerly for every adapter operation even with debug logging off.** Template literals call `formatTransactionId()` (colour-depth detection, env reads) before `debugLog` checks its flag. |
| D1 client `_send` / `toJson` (`cloudflare-internal:d1-api`) | 2.3 / 2.1 | Serialising ~7 D1 queries per Bearer request vs 3 for Basic |
| `userIdFromOpaqueToken` + `isTrustedClient` (`server/src/auth/jmap-auth.ts`) | 1.6 + 1.1 | Our own token lookup and trusted-client check (D1) |
| `userInfoEndpoint` (oauth-provider) | 0.3 | The endpoint body itself is cheap; the cost is the adapter reads beneath it |

**Hypotheses:**
- **H1, confirmed:** the cost is `oauth2UserInfo`'s Better Auth adapter work plus the extra D1 round trips. Bearer issues ~7 D1 queries per request:
  - our token lookup;
  - the trusted-client check;
  - `oauth2UserInfo`'s own token/client/user/session reads;
  - `loadUser`;
  - `buildPrincipal`.
- **H2, rejected:** `makeAuth`/`createAuth` never appear in the profile, so the per-isolate `WeakMap` cache works.
- **H3, untested:** the 111 ms production outlier as the lazy `import("./auth")` on a fresh isolate's first Bearer request. Next measurement: profile the first request after a dev restart, or watch `cpuTime` of the first request after a deploy.

**Smallest changes the evidence supports (not implemented):**
1. **Validate opaque tokens without `oauth2UserInfo`.** One D1 query joining `oauth_access_token` → `oauth_client` (trusted, enabled) → `user` (not banned), checking `accessTokenExpiresAt`, replaces ~6 queries and the whole Better Auth adapter path.
   - Expected: Bearer ≈ Basic, ~2.5–3 ms CPU and ~60 ms wall in production.
   - Must replicate the provider's checks: expiry, revocation (row deleted), client disabled, and the session still alive if tokens are session-bound.
2. **Short per-isolate cache** (30–60 s) of `sha256(token)` → principal. Bulwark sends bursts, so most requests would skip auth D1 entirely. Trade-off: revocation takes up to the TTL to apply.
3. **Eager debug formatting in Better Auth's adapter** costs every Better Auth DB operation (sign-in, get-session, …), roughly 1 ms production per operation. Options: a small `pnpm patch` guarding the template literals behind the debug flag, and/or an upstream issue.

How to check the effect: re-run the per-method probe (`?probe=` tagging + `wrangler tail --format json`) before and after, comparing `echo-bearer` against `echo-basic` `cpuTime`/`wallTime`.

## Next steps (not decided)

- Attribute CPU per JMAP method: log method names per request, correlated with tail `cpuTime`.
- Cheaper auth on the hot path: cache the token/key → principal lookup per isolate for a short TTL.
- Avoid on-demand parsing in `Email/get` on Free (return a truncated placeholder and let the alarm parse), or make it configurable.
- Re-measure with a realistic mailbox (hundreds of messages, attachments) and with password sign-in (scrypt).
