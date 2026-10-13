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

## Next steps (not decided)

- Attribute CPU per JMAP method: log method names per request, correlated with tail `cpuTime`.
- Cheaper auth on the hot path: cache the token/key → principal lookup per isolate for a short TTL.
- Avoid on-demand parsing in `Email/get` on Free (return a truncated placeholder and let the alarm parse), or make it configurable.
- Re-measure with a realistic mailbox (hundreds of messages, attachments) and with password sign-in (scrypt).
