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

## Next steps (not decided)

- Attribute CPU per JMAP method: log method names per request, correlated with tail `cpuTime`.
- Cheaper auth on the hot path: cache the token/key → principal lookup per isolate for a short TTL.
- Avoid on-demand parsing in `Email/get` on Free (return a truncated placeholder and let the alarm parse), or make it configurable.
- Re-measure with a realistic mailbox (hundreds of messages, attachments) and with password sign-in (scrypt).
