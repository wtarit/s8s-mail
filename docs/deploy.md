# Deploying s8s-mail

Deployment-specific values (zone, hostnames, resource ids, secrets) never go in tracked files. Keep them in the gitignored files below. `mail.example.com` / `webmail.example.com` stand in for your hostnames.

## 1. Resources (once)

```bash
pnpm --filter @s8s/server exec wrangler d1 create s8s-mail
pnpm --filter @s8s/server exec wrangler r2 bucket create s8s-mail-blobs
```

## 2. Local deploy config (gitignored)

1. Copy `server/wrangler.jsonc` to `server/wrangler.local.jsonc`.
2. Set:
   - the real `database_id`;
   - `PUBLIC_URL` (`https://mail.example.com`) and `WEBMAIL_ORIGIN` (`https://webmail.example.com`);
   - `MAILGUN_DOMAIN`, `SYSTEM_MAIL_FROM`;
   - the custom domain route: `"routes": [{ "pattern": "mail.example.com", "custom_domain": true }]`.
3. Put the secrets in `server/.deploy.secrets.env` (gitignored, `KEY=value` lines):
   - `BETTER_AUTH_SECRET` (`openssl rand -base64 48`);
   - `BOOTSTRAP_TOKEN` (`openssl rand -hex 32`);
   - `MAILGUN_API`.

## 3. Deploy the main Worker

```bash
pnpm build
cd server
pnpm exec wrangler d1 migrations apply DB --remote -c wrangler.local.jsonc
pnpm exec wrangler deploy -c wrangler.local.jsonc --secrets-file .deploy.secrets.env
```

Account Durable Objects migrate themselves on first use.

## 4. Email Routing (dashboard)

`wrangler email routing enable` turns routing on, but in our test it did **not** create the DNS records. Its catch-all also only accepts `forward`/`drop`. So in the dashboard (zone → Email → Email Routing):

1. Add the required records: 3 × MX, the `cf2024-1._domainkey` TXT and SPF.
2. Keep **one** SPF record that covers both receiving and the sending provider, e.g. `v=spf1 include:_spf.mx.cloudflare.net include:mailgun.org ~all`.
3. Catch-all → **Send to a Worker** → `s8s-mail`. The Worker rejects unknown recipients itself (`5.1.1`).

## 5. First admin

```bash
curl -X POST https://mail.example.com/api/bootstrap \
  -H "Authorization: Bearer $BOOTSTRAP_TOKEN" -H 'content-type: application/json' \
  -d '{"name":"Admin","primaryAddress":"admin@example.com","recoveryEmail":"you@elsewhere.example"}'
```

This only works while there are no users. The invite link goes to the recovery address and is also returned in the response.

## 6. Webmail (Bulwark Lite, from the fork's `feat/lite-generic-oidc` or later)

```bash
CI=true LITE_TARGET=static LITE_LOCALES=en LITE_JMAP_SERVER_URL=https://mail.example.com npm run build:lite
```

Then edit `out/config.json`: `"oauthClientId": "bulwark-lite"`, `"oauthOnly": true`, `"oauthResource": "https://mail.example.com/jmap"`, `"appName"`.

- `oauthResource` (fork branch `feat/lite-oidc-resource` or later) makes the webmail request JWT access tokens. It must equal `${PUBLIC_URL origin}/jmap` exactly. Without it, the webmail gets opaque tokens, which still work but cost ~3× the CPU per JMAP request.

- **SSO-only is required.** Bulwark's password form would send the account password as Basic auth, and our JMAP endpoint only accepts **app passwords** via Basic.

Workers Static Assets quirks (Lite's `_redirects` targets Netlify/Pages):
- Rewrite targets ending in `/index.html` loop, because assets strip `index.html` from URLs. Rewrite `/x/mail/*  /x/mail/index.html  200` to `/x/mail/*  /x/mail/  200`.
- At most **100 dynamic redirect rules**. 27 locales × 5 surfaces exceeds it, so build with `LITE_LOCALES`.

Deploy as an assets-only Worker with `"assets": { "directory": "<out>", "not_found_handling": "404-page" }` and a custom-domain route for `webmail.example.com`. The Bulwark OAuth client (`bulwark-lite`, redirect `${WEBMAIL_ORIGIN}/oauth/callback`, trusted, PKCE) is created by bootstrap, together with the JMAP OAuth resource (`${PUBLIC_URL origin}/jmap`) it must be linked to so that the webmail gets JWT access tokens. On an existing deployment, call `POST /api/admin/oauth-clients/ensure-defaults` (as an admin) once after deploying this change, before the webmail starts sending `resource` (an unlinked client gets `invalid_target`).

## Notes

- A zone with Cloudflare bot protection may block uncommon user agents (we saw `Python-urllib` get 403). Scripts should send a normal `User-Agent`.
