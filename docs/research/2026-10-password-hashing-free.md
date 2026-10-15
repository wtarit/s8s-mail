# Password hashing on Workers Free: measurements and options

Date: 2026-10-14. Follows `2026-10-auth-storage-webmail.md` § "Password hashing on Workers" and `2026-10-free-plan-observations.md`. Status: research, **no decision yet**. Nothing in `server/` was changed.

✅ = measured or read in code in this session. Everything else is from Haiku research passes; verify it before relying on it.

## TL;DR

- **The current setup does not hold up on Free** ✅. Better Auth's native scrypt costs **~90 ms CPU per sign-in** on the deployed Worker (64–297 ms), about 9× the 10 ms limit.
  - The default (N=2^14, r=16, p=1) is also **below OWASP's scrypt minimum**: 1/4 to 1/2.5 of the work (§1).
  - The first ~35 sign-ins passed on burst allowance.
  - After that, Cloudflare started killing them: **4, then 6, then 8 of 10** per one-minute burst (`exceededCpu`, HTTP 503).
  - **12 idle minutes later, every sign-in was still killed.** Password login recovered only 10–20 minutes after the last overrun. About 60 sign-in attempts in 6 minutes, within our own rate limit, locked it out for ~30 minutes in total.
- **Everything we could offload to on Cloudflare is also limited to 10 ms on Free**: DOs, Queues consumers, Workflows steps, cron. Service-binding CPU is summed for billing. None of these is a real fix.
- **Lowering the parameters enough to fit** leaves room for only **~1/16 of today's scrypt work and ~1/64 of OWASP's floor**: scrypt N=2^11, r=8 (2 MiB). That is too weak to be worth keeping passwords for.
- **Fits with full strength:** move the expensive KDF to the browser ("server relief"). The SPA runs Argon2id and sends the result. The server stores and checks a keyed SHA-256/HMAC of it, which costs **<0.1 ms**.
  - It plugs into Better Auth's `emailAndPassword.password.{hash,verify}`.
  - **Recommended**, details in §4.
- OPAQUE also fits (~1–2 ms server CPU) but is much more work. Dropping passwords on Free costs no code. Paying for Workers ($5/mo, 30 s CPU) removes the problem entirely.

## 1. What runs today ✅

**Bundle.** `wrangler deploy --dry-run --outdir` of `feat/v1` (c21c774):
- It contains `@better-auth/utils@0.4.2/dist/password.node.mjs` with `import { randomBytes, scrypt } from "node:crypto"`. The pure-JS `@noble/hashes` scrypt fallback is not in the bundle.
- Parameters: **N=16384, r=16, p=1, dkLen=64**. That is 32 MiB per hash, the same work as N=2^15, r=8.
- **This is below OWASP's scrypt minimum**, at ~1/4 to ~1/2.5 of the work (work ∝ N·r·p):

  | | N | r | p | Memory | Work vs ours |
  |---|---|---|---|---|---|
  | **Ours (Better Auth default)** | 2^14 | 16 | 1 | 32 MiB | 1× (2^18) |
  | OWASP row 1 | 2^17 | 8 | 1 | 128 MiB | 4× |
  | OWASP row 2 | 2^16 | 8 | 2 | 64 MiB | 4× |
  | OWASP row 3 (same memory as ours) | 2^15 | 8 | 3 | 32 MiB | 3× |
  | OWASP row 4 | 2^14 | 8 | 5 | 16 MiB | 2.5× |
  | OWASP row 5 | 2^13 | 8 | 10 | 8 MiB | 2.5× |

  - It is still memory-hard and far stronger than a fast hash, but it is not OWASP-compliant.
  - Raising it to compliance would cost 2.5–4× more CPU: ~210–350 ms per sign-in in production.
  - The OWASP rows are from the Password Storage Cheat Sheet, via a Haiku research pass.
- Stored format: `hexsalt:hexkey`. The parameters are not encoded in it.

**Hashes per endpoint** (Better Auth 1.7.7 source):

| Endpoint | scrypt runs |
|---|---|
| `POST /sign-in/email`, user found | 1 (verify) |
| `POST /sign-in/email`, unknown email or no password | 1 (dummy hash, against timing-based enumeration) |
| `changePassword` (our `POST /api/account/password` when a password exists) | **2**: hash the new password, then verify the current one |
| `setPassword` (invite flow / first password) | 1 |
| Admin create user | 0. Our `api/users.ts` creates users without a password. |

So **any** request to `/sign-in/email` with a well-formed body costs one full scrypt, even for an unknown email. Requests that fail validation do not hash.

## 2. Production measurement ✅

**Method:**
- Target: the deployed `s8s-mail` Worker (Workers Free, version from 2026-10-13).
- Requests: `POST /api/auth/sign-in/email` for a non-existent `@example.com` address. This takes the dummy-hash path, so it costs the same scrypt as a real verify. No account was touched.
- Tagged `?probe=`. `cpuTime`/`wallTime`/`outcome` read from `wrangler tail --format json`.
- Pacing: our rate limit (`/sign-in/email`: 10 per 60 s per IP) caps one client at 10 per minute. So: 6 bursts of 10 back-to-back requests, one burst per minute.

**Results:**

| Burst (1/min) | completed `ok` | killed `exceededCpu` (HTTP 503) |
|---|---|---|
| 1–3 | 30/30 | 0 |
| 4 | 6/10 | 4 |
| 5 | 4/10 | 6 |
| 6 | 2/10 | 8 |

- CPU of the 42 completed sign-ins: **median 92 ms, p90 127 ms, min 64, max 297**. Wall time is ~170–300 ms. The 297 ms outlier was the 4th request of the first burst, probably a fresh isolate loading Better Auth.
- Most killed requests report `cpuTime` = **10 ms exactly**. **Once the allowance is spent, the limit is enforced at 10 ms.** A few killed requests report 18–87 ms.
- `GET /get-session` requests interleaved between the bursts stayed `ok` (1–4 ms).
- **Baseline without hashing:** `/sign-in/email` with a body that fails validation costs **4–6 ms**. That covers routing, the Better Auth context, and the rate-limit D1 write. A successful sign-in also creates a session and a cookie, an estimated +1–2 ms. **So the hash gets at most ~3–4 ms of the 10 ms budget.**
- **Recovery after idle: slow.**
  - After burst 6, the Worker got ~12 minutes with no sign-ins (5 cheap invalid-body requests only).
  - Then a further burst of 10: **all 10 were killed**, including the first, at 10–34 ms CPU.
  - `get-session` was still fine. The penalty applies to requests that go over 10 ms, not to the whole Worker.
  - Follow-up: single sign-ins every 10 minutes to time the recovery.
    - The sign-in ~10 min after the last killed request was **still killed** (17 ms CPU).
    - The ones at ~20 and ~30 min **passed** (179 ms and 83 ms CPU).
  - **The allowance came back somewhere between 10 and 20 minutes after the last overrun.** The whole lockout lasted ~30 minutes, from the first kill at about minute 4 to the first success at about minute 33.

**What it means:**
- One user signing in now and then will usually pass, on burst allowance.
- Anyone who sends ~10 well-formed sign-in requests per minute (one IP is enough, the rate limit allows that) uses up the allowance within ~3–4 minutes. After that, real sign-ins fail with 503 until 10–20 minutes after the last overrun. An attacker who sends a few requests every ~10 minutes keeps it locked indefinitely (inferred, not tested). **That is a cheap, anonymous denial of password login.** It needs no valid email, since unknown emails also hash.
- Whether a kill also drops other requests in flight on the same isolate (JMAP, SSE) was not measured (UNVERIFIED).

## 3. Options

### 3a. Local benchmark of the candidates ✅

**Setup:**
- A scratch Worker in local `wrangler dev` (workerd 1.20261006.1, `nodejs_compat`).
- Each request runs n iterations; per-op time is (total − no-op) / n, best of 3.
- **Calibration:** the default scrypt is 50 ms locally vs a ~85 ms hash in production (sign-in median minus the ~6 ms overhead), so **production ≈ 1.6–1.8× local** for this workload.

| Hash | local ms/op | est. prod ms | fits ~3–4 ms? |
|---|---|---|---|
| scrypt N=2^14 r=16 p=1 (**Better Auth default**) | 49.9 | ~85 (measured) | no |
| scrypt N=2^17 r=8 (OWASP first row) | 203 | ~350 | no |
| scrypt N=2^15 r=8 | 49.9 | ~85 | no |
| scrypt N=2^14 r=8 | 24.1 | ~40 | no |
| scrypt N=2^13 r=8 | 11.1 | ~19 | no |
| scrypt N=2^12 r=8 | 5.3 | ~9 | no |
| scrypt N=2^11 r=8 (2 MiB) | 2.6 | ~4.5 | borderline |
| scrypt N=2^10 r=8 (1 MiB) | 1.3 | ~2.2 | yes |
| Argon2id m=19 MiB t=2 (OWASP floor), WASM | 46.3 | ~80 | no |
| Argon2id m=12 MiB t=3 (OWASP), WASM | 37.7 | ~65 | no |
| Argon2id m=4 MiB t=1, WASM | 6.4 | ~11 | no |
| Argon2id m=1 MiB t=1, WASM | 2.0 | ~3.5 | borderline |
| `@noble/hashes` scrypt N=2^14 r=16 (pure JS, old fallback) | 93 | ~160 | no |
| WebCrypto PBKDF2-SHA256 100k (workerd max; never use) | 9.8 | ~17 | no |
| WebCrypto SHA-256 (server-relief verify) | <0.01 | <0.1 | **yes** |
| OPAQUE server login (`@serenity-kit/opaque`, measured in Node 24) | start 0.92 + finish 0.01 | ~1–2 | **yes** |

**WASM on Workers** ✅:
- **`hash-wasm` does not run on Workers**: `WebAssembly.compile(): Wasm code generation disallowed by embedder`. Workers only accept WASM modules imported at build time.
- **`argon2-wasm-edge`** (MIT, built from hash-wasm's C code) works with `import argon2WASM from "argon2-wasm-edge/wasm/argon2.wasm"` + `setWASMModules`. All Argon2 rows above use it.
- `@serenity-kit/opaque` also compiles its WASM at runtime. On Workers its `.wasm` would have to be extracted and imported.

### 3b. Lower scrypt / Argon2id parameters

- To fit, the hash must take ~3–4 ms in production: **scrypt N=2^10–2^11, r=8 (1–2 MiB) or Argon2id m=1 MiB, t=1.**
- Strength against offline cracking of a leaked D1:
  - **~1/16–1/32 of today's work**;
  - **~1/64–1/128 of OWASP's scrypt floor** (N=2^17, r=8, or its equal-cost rows);
  - **~1/20 of OWASP's Argon2id floor** (m=19 MiB, t=2).
- At 1–2 MiB per guess, GPUs and ASICs run many guesses in parallel. The memory-hardness that makes scrypt/Argon2 worth using is mostly gone.
- **No published guidance goes below OWASP's tables.** The only "free tier" Argon2id preset found (`imjlk/cloudflare-auth-hasher-template`, m=4 MiB, t=1) says it is "not an OWASP-equivalent recommendation", and by our numbers it still does not fit (~11 ms).
- Even then, a successful sign-in sits at ~8–10 ms in total. `changePassword` hashes twice, so it would still go over.
- Migration: the stored format has no parameters, so a custom `hash/verify` would need a versioned format. Old hashes would be verified once at full cost.
- **Verdict: not worth it.** It keeps the passwords but throws away most of the protection, and it still sits on the edge of the budget.

### 3c. Offload hashing to another Cloudflare invocation

| Target | CPU on Free | Notes |
|---|---|---|
| Service binding (hasher Worker) | 10 ms per invocation (UNVERIFIED whether separate) | Pricing page: billed as "the total amount of CPU time used across both Worker A and Worker B". Even if B got its own 10 ms, an 85 ms hash still doesn't fit, and B's own burst allowance would run out the same way. |
| Durable Object | 10 ms (same as Workers, per `CLAUDE.md` / DO limits page) | The DO limits page says "the same per invocation CPU limits as any Workers do". |
| Queue consumer | 10 ms on Free (UNVERIFIED; the docs' 30 s default is Paid) | Asynchronous, so no use for an interactive login anyway. |
| Workflows step | 10 ms on Free ✅ (Workflows limits page) | Asynchronous. |
| Cron trigger | 10 ms on Free ✅ (Workers limits page) | Asynchronous. |

- **No Cloudflare offload target gets more than 10 ms on Free.**
- The limits page says "Each isolate has some built-in flexibility". Spreading hashes across isolates or objects to draw on several burst allowances would be fragile, and it games the plan. Not pursued.
- An offload target outside Cloudflare breaks "host everything on Cloudflare".

### 3d. Client-side pre-hashing ("server relief")

How it works:
- The browser derives `k = Argon2id(password, salt_u)` at strong parameters and sends `k` instead of the password.
- The server stores `HMAC-SHA256(pepper, k)` and compares in constant time.
- This is libsodium's documented "server relief" pattern. Bitwarden and 1Password use similar client-side KDFs.

**Server cost:** one HMAC, <0.1 ms. Sign-in drops to the ~5–7 ms baseline.

**Strength:**
- Someone with a D1 dump must still run Argon2id per guess at the *client's* parameters, which can be OWASP-or-stronger (e.g. m=64 MiB, t=3).
- With the pepper kept in a Worker secret (e.g. derived from `BETTER_AUTH_SECRET`), a D1 dump alone cannot even be attacked offline.
- The stored value cannot be replayed to log in, because that needs `k`, a preimage of the HMAC.

**Client cost** ✅:
- Single-thread WASM Argon2id in Node 24: m=19 MiB/t=2 ≈ 48 ms; m=64 MiB/t=3 ≈ 224 ms.
- Expect 2–5× that on phones (UNVERIFIED). `hash-wasm` works in browsers, which allow runtime WASM compilation.

**Salt:**
- Use a deterministic per-user salt, e.g. `SHA-256("s8s-mail/v1" ‖ PUBLIC_URL ‖ lowercase(email))`.
- No salt-lookup endpoint is needed, so it creates no user enumeration. It is the same for unknown users.
- Precomputation then targets one user on one deployment, which is acceptable for this pattern (libsodium does the same with "a pseudorandom seed that has to always be the same for a given user name").
- When the admin changes a user's email, the stored hash must be invalidated, or the salt version stored.

**Better Auth fit:**
- `emailAndPassword.password: { hash, verify }` is a documented option. `hash` would return a versioned string (`sr1:<hmac-hex>`), and `verify` recomputes the HMAC.
- `changePassword`'s double hash becomes two HMACs.

**Costs and caveats:**
- Only our SPA can sign in with a password. Its login, invite (set password) and account (change password) pages all need the client-side KDF. A raw password POSTed to `/api/auth/sign-in/email` by anything else simply fails. Bulwark signs in through our SPA (OIDC), so it is unaffected.
- Password policy (minimum length, breach checks) can only be enforced in the client. The server only ever sees a 64-hex `k`, which always passes `minPasswordLength`.
- `k` is a password-equivalent for this site if intercepted (TLS, logs, XSS), but it does not reveal the password itself.
- A compromised SPA can capture passwords, but that is equally true today.
- Existing scrypt hashes cannot be converted, because the server never sees the password again. On the test deployment, simply reset passwords. Otherwise keep a legacy `verify` branch (costly, once per user) during a migration window.
- Changing the client parameters later needs a versioned `k` (`sr1`, `sr2`…) and re-enrolment at the next sign-in.
- Another advantage: an attacker can no longer burn our CPU allowance by POSTing sign-ins, so the 503 lockout in §2 goes away.

**Is this common practice?** It is established but niche, **not the norm for ordinary web logins**.

Mainstream guidance assumes the server receives the password and hashes it:
- NIST SP 800-63B rev. 4 §3.1.1.2 requires password verifiers to salt and hash passwords with "a suitable password hashing scheme" ([NIST](https://pages.nist.gov/800-63-4/sp800-63b.html)).
- The OWASP Password Storage Cheat Sheet discusses server-side *pre-hashing* (SHA-2 before bcrypt, with a pepper, and warns about password shucking). It does **not** cover client-side hashing ([OWASP](https://cheatsheetseries.owasp.org/cheatsheets/Password_Storage_Cheat_Sheet.html)).

It is common where the server must not learn the password, usually because the password also unlocks encrypted data:
- **Bitwarden** is the closest match to 3d.
  - The client derives a key with PBKDF2 or Argon2id and sends a "Master Password Hash".
  - The server hashes that again with PBKDF2-SHA256 (random salt, 600,000 iterations) before storing it.
  - Sources: [Bitwarden security whitepaper](https://bitwarden.com/help/bitwarden-security-white-paper/), [KDF algorithms](https://bitwarden.com/help/kdf-algorithms/).
- **libsodium** documents the pattern as "Server relief": the client computes the expensive hash and the server stores a cheap hash of it ([libsodium docs](https://libsodium.gitbook.io/doc/password_hashing)).
- **1Password** and **Proton** go further with SRP (see 3e): nothing password-equivalent is sent at all.
  - 1Password: [blog](https://1password.com/blog/developers-how-we-use-srp-and-you-can-too).
  - Proton: [blog](https://proton.me/blog/encrypted-email-authentication). This is a 2016 post, so it does not confirm current practice.

Why ordinary sites don't do it: it needs a custom client, password policy can only be enforced in the client, and Better Auth has no built-in support. For s8s-mail it is defensible only because our SPA is the sole place a password is entered.

These references were checked by a Haiku pass via WebFetch summaries. Re-read the pages before quoting them publicly.

### 3e. OPAQUE (RFC 9807) / SRP

- **Server CPU:** ~1 ms (OPRF + 3DH, `@serenity-kit/opaque`). It fits.
- **Stronger than server relief:** the server never receives a password-equivalent, and nothing replayable crosses the wire.
- **Costs:**
  - Two round trips with server state between them.
  - Custom Better Auth endpoints. No official plugin; a community `better-auth-opaque` exists (UNVERIFIED, not evaluated).
  - Re-packaging the WASM for Workers.
  - RFC 9807 is Informational. `@cloudflare/opaque-ts` targets draft-07, not the RFC.
  - Same SPA-only and client-policy caveats as 3d.
- **Verdict:** much more code and maintenance for a margin over 3d that matters little in a small, admin-provisioned deployment.

### 3f. Drop passwords on Free (passkey + magic link)

- Cost: config only (`emailAndPassword.enabled: false` on Free, hide the UI). Passkey verification is cheap.
- Downsides:
  - Every sign-in on a device without a synced passkey becomes a magic link to the recovery address. That means a Mailgun send each time, and depending on a second inbox.
  - Password login stays Paid-only, so there are two code paths to keep.

### 3g. Workers Paid

- $5/month minimum. 30 s CPU per request by default.
- The current setup works unchanged, but the burst concern is gone only because the budget is large, not because a hash is cheap.

## 4. Recommendation

**Server relief (3d) on every plan**, not only on Free, so there is a single code path:
- **SPA:** a `deriveLoginKey(email, password)` helper (Argon2id via `hash-wasm`, m=64 MiB, t=3, p=1, or m=19 MiB/t=2 if phones are too slow). It is used by the login, invite and change-password pages, plus client-side password policy.
- **Server:** `emailAndPassword.password = { hash, verify }`, an HMAC-SHA256 with a pepper derived from a Worker secret, versioned `sr1:` format, constant-time compare. About 30 lines in `server/src/auth/` (outside `jmap-auth.ts`).
- **Migration:** reset existing test passwords. No legacy scrypt branch.
- **Effort:** roughly a day including tests.
- **What it costs us:**
  - Passwords only work through our SPA.
  - Password policy is client-enforced.
  - +~200 ms to 1 s of client time at sign-in.
  - The parameters are locked in the format and need versioning to change.
- **How to verify:** repeat §2 (6 bursts of 10). Expect `cpuTime` ≈ 5–7 ms and zero `exceededCpu`.

If keeping passwords is not worth that, fall back to 3f (passkey + magic link only on Free). Do **not** lower scrypt parameters (3b) or build a hasher Worker (3c).

## Sources

- Better Auth 1.7.7 source: `api/routes/sign-in.mjs` (dummy hash for unknown users), `api/routes/update-user.mjs` (`changePassword` hash + verify), `crypto/password.mjs`; `@better-auth/utils@0.4.2` `password.node.mjs`.
- Better Auth docs, custom hasher: https://www.better-auth.com/docs/authentication/email-password
- OWASP Password Storage Cheat Sheet: https://cheatsheetseries.owasp.org/cheatsheets/Password_Storage_Cheat_Sheet.html
- Workers limits / pricing (service bindings CPU): https://developers.cloudflare.com/workers/platform/limits/ , https://developers.cloudflare.com/workers/platform/pricing/
- DO limits: https://developers.cloudflare.com/durable-objects/platform/limits/ · Workflows limits: https://developers.cloudflare.com/workflows/reference/limits/
- libsodium "server relief": https://libsodium.gitbook.io/doc/password_hashing
- Client-side hashing in practice: Bitwarden whitepaper https://bitwarden.com/help/bitwarden-security-white-paper/ · 1Password SRP https://1password.com/blog/developers-how-we-use-srp-and-you-can-too · Proton SRP https://proton.me/blog/encrypted-email-authentication
- NIST SP 800-63B rev. 4 §3.1.1.2: https://pages.nist.gov/800-63-4/sp800-63b.html
- OPAQUE: RFC 9807; https://github.com/serenity-kit/opaque ; https://github.com/cloudflare/opaque-ts
- `argon2-wasm-edge`: https://github.com/ComicScrip/hash-wasm-edge · `imjlk/cloudflare-auth-hasher-template`
