Better Auth setup and auth middleware.

- `auth.ts`: `makeAuth(env, database)` (all plugins) and `createAuth(env)` (cached per isolate). Import it only through `index.ts` (`getAuth`, lazy).
- `config.ts`: light constants (scopes, base path, app-password prefix) that cold-start code may import statically.
- `jmap-auth.ts`: `jmapAuth` Hono middleware for the JMAP module. Accepts JWT access tokens (`resource=<origin>/jmap`, verified locally) and Basic app passwords; opaque tokens get 401. Sets `c.var.principal` (`Principal` in `types.ts`).
- `factors/`: the account security model (see below): per-session factor stamps, the `requireAccountChange` gate, pending sign-ins, the hooks that apply them to Better Auth's own endpoints.
- `enrollment/`: invite enrollment: the enrollment-only session and the atomic "save first factor + full reset" batch.
- `opaque/`: OPAQUE password endpoints (sign-in, set/change, step-up) and their encrypted handshake state.
- `request-context.ts`: `runInBackground()` (`waitUntil` via AsyncLocalStorage).
- Schema: `../db/auth-schema.ts` is generated, see CLAUDE.md "Better Auth on Workers".

OPAQUE uses the exact published `@serenity-kit/opaque@1.1.0` cryptography. Server
commands run `opaque:prepare` to hash-check its source, extract the unchanged
Wasm, and replace only the inline compilation loader with a static module
import. Generated artifacts, MIT notices, and provenance live in the ignored
`.generated/` directory; runtime code imports `opaque-runtime.ts`, never the
package's normal runtime entry. An upgrade requires reviewing the pinned hashes
and loader transformation in `server/scripts/prepare-opaque.mjs`.

Run `pnpm --filter @s8s/server opaque:setup` once to append `OPAQUE_SERVER_SETUP`
to the ignored `server/.dev.vars` with mode 0600. It preserves other bindings,
refuses to replace an existing setup, and never prints the secret. Back up the
setup securely and provision the same value as a production Worker secret;
changing or losing it invalidates existing password registrations. Local files
are not uploaded automatically. See [Cloudflare secrets](https://developers.cloudflare.com/workers/configuration/secrets/)
and [Serenity setup](https://opaque-auth.com/docs/get-started/add-to-existing-project).

## Account security model (as built)

The spec is CLAUDE.md "Enrollment and recovery" and "Account security model"; this is how it maps to code.

**Session stamps.** `session` has `passwordVerifiedAt`, `passkeyVerifiedAt`, `recoveryVerifiedAt` and `inviteId` (Better Auth `session.additionalFields`, `input: false`; regenerate `db/auth-schema.ts` as usual). Anything that creates a session without stamping it (admin impersonation, a plugin we did not wire) yields a session with no verified factor, so it can never change the account. `freshAge` is `0`: Better Auth's createdAt-based `freshSessionMiddleware` (used by `/list-sessions` and the passkey endpoints) is switched off, and `requireAccountChange` is the only freshness rule. It was not set to 300 because that would break `/list-sessions` for the sessions page.

**`requireAccountChange(env, ctx, { enrollment?, proven? })`** (`factors/guard.ts`, rules in the pure `factors/policy.ts`) allows a change when the session is not impersonated and every factor the user has (password = `opaque_credential` row, passkey = at least one `passkey` row) was verified in this session within 5 minutes. A fresh `recoveryVerifiedAt` stands in for exactly one missing factor. Otherwise it throws `REAUTHENTICATION_REQUIRED` with `stale` (factors still to verify) and `oneOf` (any one of them suffices). Impersonation answers `ACCOUNT_CHANGE_NOT_ALLOWED`. It guards `/opaque/password/start|finish` and, as Better Auth before-hooks (`factors/hooks.ts`), `/passkey/generate-register-options`, `/passkey/verify-registration`, `/passkey/delete-passkey` and `/api-key/create`. Deleting a user's last factor is refused (`LAST_FACTOR`). Renaming a passkey, signing sessions out and deleting app passwords only need a session. `GET /api/me` reports the same status (`accountChange`) so the SPA can ask before acting.

**Sign-in** (`factors/sign-in.ts`, `resolveSignIn`). A passkey alone signs in. A password alone signs in only a user without a passkey; for a 2FA user `/opaque/login/finish` creates no session. It answers `passkeyRequired` and stores a *pending sign-in*: a `pending_sign_in` row (sha256 of the cookie token, user, which stamps are verified, 5-minute expiry, consumed by `DELETE ... RETURNING`) and an HttpOnly cookie. Passkey authentication then creates the session with both stamps (a `session.create.before` database hook reads the cookie for `/passkey/verify-authentication`). The OAuth `oauth_query` rides on the passkey POST, so Better Auth's own continuation hook resumes the authorization from that second step. `GET /pending-sign-in` tells the SPA what is pending.

**Recovery link** (`/magic-link/verify`). The same hook decides per user: a password-only or passkey-only user gets a full session with `recoveryVerifiedAt`; a 2FA user gets no session. The hook returns `false` (Better Auth's magic-link endpoint then raises its error redirect), and an after hook turns that into a pending recovery cookie plus a redirect to the original `callbackURL`, with no error. Passkey authentication or an OPAQUE login (with the pending cookie) then creates the session with `recoveryVerifiedAt` and that factor. A user with no factors gets neither a session nor a pending sign-in.

**Step-up** keeps the current session. Password: `/step-up/password/start|finish`, an OPAQUE login handshake (purpose `stepup`) bound to the session; success stamps `password_verified_at`. Passkey: Better Auth's `verify-authentication` can only create a new session. Instead of carrying stamps over and revoking the old session (which would end its OAuth sessions and back-channel-log the webmail out), an after hook notices that the request already has a session of the same user, stamps *that* session, deletes the just-created one and removes its cookies from the response. The new session never leaves the Worker, and no other session is touched.

**Password change** (`opaque/password.ts`, `opaque/password-store.ts`) always proves the current password in the same OPAQUE exchange (combined registration + login handshake), except for a first password, fresh recovery and invite enrollment. A correct proof counts as the password verification. One D1 batch upserts the record, deletes the user's pending handshakes and pending sign-ins, revokes OAuth tokens, expires other sessions and deletes ALL app passwords; every statement repeats the active-session guard, so a session that ended meanwhile changes nothing. Better Auth then deletes the expired sessions (OIDC logout hooks run). A login handshake that already finished verification but has not created its session yet can still land one session after a concurrent password change; the old credential-version recheck was removed on purpose.

**Invites** (`enrollment/`, `api/invite-routes.ts`). Opening a link (`POST /api/invite/:token/session`) does not use the invite up: it opens an *enrollment-only* session (`inviteId` set, expires with the invite). A before hook refuses that session everywhere except the first-factor setup, `/get-session`, `/sign-out` and the public sign-in endpoints, and `requireSession` (our REST API) refuses it too, so it reaches no JMAP, OAuth, userinfo, `/api/me` or other account change. Saving the first factor (password in `/opaque/password/finish`, passkey in the passkey plugin's `registration.afterVerification`) runs `commitFirstFactor`: ONE D1 batch claims the invite (`claim_id`, still unused and unexpired, only one concurrent attempt wins), saves the factor, runs the full reset (old password, passkeys, app passwords, OAuth tokens, pending handshakes, every other session) and turns the session into a normal one with that factor verified now. The loser changes nothing and gets `INVITE_USED` / `INVITE_UNAVAILABLE`. The passkey plugin inserts its row *after* `afterVerification`, so for an enrollment session the passkey is inserted inside the batch and `afterVerification` then throws a sentinel `APIError`; an after hook replaces it with the success response, which keeps the plugin from inserting a second row. A new admin invite deletes the old unused invites and the enrollment sessions opened from them.

**Blocked routes.** Core plaintext-password and admin-created-user routes are in `betterAuth({ disabledPaths })` and answer 404.

The browser worker does Serenity's default password stretching. It does not compare
the server's OPAQUE public key with anything fetched from the same server (that
proved nothing), so there is no `/opaque/config` endpoint. Production CSP must permit
same-origin workers and WebAssembly (usually `worker-src 'self'` and
`script-src 'self' 'wasm-unsafe-eval'`). No reduced KDF or server-side dummy client
registration is used.

Before deploying, provision `OPAQUE_SERVER_SETUP` and apply the D1 schema files.
The old test `credential` account rows are deliberately discarded. There is no
legacy password fallback. Never generate fresh setup material at application
startup. The deployed standalone probe's CPU figures do not establish the full
application's Workers Free suitability; measure the complete endpoints after
deployment. Existing passkey/magic-link login remains available without OPAQUE
configuration.
