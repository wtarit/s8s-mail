# Account security

Status: **spec**. Binding for `server/src/auth/` and the account pages in `web/`. How it's built: `server/src/auth/README.md`.

## 1. Factors and sign-in

- **Factors:** a password and passkeys. A user has one or both. A user who has both is a **2FA user**.
- Better Auth core plaintext-password endpoints are disabled. Sign-up is disabled on every method.
- A **passkey alone** signs in.
- A **password alone** signs in only when the user has no passkey. A 2FA user's password sign-in completes only after passkey authentication, and that session counts both factors as verified.

## 2. Enrollment

- The admin creates a user and receives a **one-time invite link** to hand over out of band. The user opens it and enrolls a passkey, a password, or both.
- **Opening the invite does not use it up.** The link itself authorizes enrolling the first factor, with no 5-minute window. It stays valid until it expires (7 days) or the first factor is saved, so the user can leave and come back.
- **Saving the first factor uses up the invite** and signs the user in with that factor just verified. The second factor can then be added right away or later through normal step-up.
- **An invite is a full reset, applied when the first factor is saved**, not when the link is opened. In the same D1 batch it deletes the user's old password, passkeys and app passwords and ends all their sessions. To lock a user out immediately, the admin disables the account.
- An expired, unused invite needs a new one from the admin. A recovery link cannot replace it.

## 3. Recovery

Each user has an **external recovery address**, set by the admin and stored in D1. Magic links always go to that address, **never to the user's own mailbox on this server**, because that would be circular. Magic-link and invite emails go out through the configured sending provider.

**The recovery link (magic link) stands in for exactly one factor, never both:**

| User has | Recovery link alone | Recovery link + other factor |
|---|---|---|
| Password only | Full session; may set a new password | n/a |
| Passkey only | Full session; may add a passkey | n/a |
| 2FA | Not signed in yet: the link is the first half of recovery | Link + passkey: signed in, may set a new password. Link + password: signed in, may manage passkeys |

The link never works alone for a 2FA user (no mail access, no OAuth); otherwise the recovery address would bypass both factors. Losing both factors needs a new admin invite. A user with no factors has nothing for the link to stand in for, so it does not sign them in.

## 4. Account changes

Account changes are setting or changing the password, adding or removing a passkey, and creating an app password.

- They need **every factor the user has**, verified in this session within the last **5 minutes** (a time window, not one-time grants). During recovery the link counts as the missing factor.
- When a factor is stale, the SPA asks for just that factor. Verifying a factor for an existing session does not start a new session.
- **Changing the password also always proves the current password** in the same OPAQUE exchange. The only exceptions are a first password and recovery of a forgotten one.
- Removing the user's last factor is refused.
- Impersonated sessions cannot make account changes.
- Signing out sessions, deleting app passwords and renaming passkeys only need a session.
- **A password change** ends the user's other sessions, revokes their OAuth tokens and **all app passwords**, and invalidates pending OPAQUE handshakes, in one D1 batch.

## 5. Password authentication

- Passwords use OPAQUE (`@serenity-kit/opaque`) through application-owned Better Auth server and client plugins. No server-side password KDF runs.
- Password stretching runs in an ephemeral browser Web Worker. Passwords and client state never go over HTTP. The server stores OPAQUE registration records against immutable user IDs.
- Login handshake state is encrypted in D1 (it contains the value the client must return), expires after five minutes, and is atomically consumed on completion. Registration is stateless on the server.
- `OPAQUE_SERVER_SETUP` is generated once (`pnpm opaque:setup`) and must persist. Keep it **separate from `BETTER_AUTH_SECRET`**. Losing or changing it invalidates every password registration.
- **No legacy password path.** There are no plaintext or server-hashed passwords to fall back to.
- The server cannot see the password, so the password length policy is enforced in the browser only.

## 6. App passwords

App passwords authenticate JMAP over Basic auth, for clients that cannot do OAuth. They are random high-entropy keys, so a fast hash is enough; JMAP never runs a password KDF per request. Creating one is an account change.
