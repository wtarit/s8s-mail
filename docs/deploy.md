# Deploying s8s-mail

Deployment-specific values (zone, hostnames, resource ids, secrets) never go in tracked files. Keep them in the gitignored `server/wrangler.local.jsonc` or in Worker secrets. `mail.example.com` stands in for your hostname.

## 1. Resources (once)

```bash
pnpm --filter @s8s/server exec wrangler d1 create s8s-mail
pnpm --filter @s8s/server exec wrangler r2 bucket create s8s-mail-blobs
```

## 2. Local deploy config (gitignored)

1. Copy `server/wrangler.jsonc` to `server/wrangler.local.jsonc`.
2. Set:
   - the real `database_id`;
   - `PUBLIC_URL` (`https://mail.example.com`);
   - `MAILGUN_DOMAIN`, `SYSTEM_MAIL_FROM`;
   - the custom domain route: `"routes": [{ "pattern": "mail.example.com", "custom_domain": true }]`.

## 3. Deploy the main Worker

```bash
pnpm build
cd server
pnpm exec wrangler d1 migrations apply DB --remote -c wrangler.local.jsonc
pnpm exec wrangler deploy -c wrangler.local.jsonc
```

Then set the secrets once. They persist across later deploys, so only re-run this to rotate one:

```bash
pnpm exec wrangler secret put BETTER_AUTH_SECRET -c wrangler.local.jsonc  # openssl rand -base64 48
pnpm exec wrangler secret put BOOTSTRAP_TOKEN -c wrangler.local.jsonc     # openssl rand -hex 32
pnpm exec wrangler secret put MAILGUN_API -c wrangler.local.jsonc
```

`OPAQUE_SERVER_SETUP` is the OPAQUE server key (see `server/src/auth/README.md`). Every password depends on it, so create it once and keep a copy: if it is lost or changed, all passwords stop working. This writes it to the gitignored `.dev.vars.deploy` and uploads it without printing it:

```bash
(umask 077; node --input-type=module -e 'import { ready, server } from "@serenity-kit/opaque"; await ready; process.stdout.write(`OPAQUE_SERVER_SETUP=${server.createSetup()}\n`)' > .dev.vars.deploy)
sed -n 's/^OPAQUE_SERVER_SETUP=//p' .dev.vars.deploy | pnpm exec wrangler secret put OPAQUE_SERVER_SETUP -c wrangler.local.jsonc
```

Use production values that differ from your local `server/.dev.vars`. Keep `BOOTSTRAP_TOKEN` at hand for step 5.

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

## 6. Webmail

Nothing to deploy separately. `pnpm build` (step 3) puts the webmail release pinned in `web/webmail.json` into `web/dist/webmail/`, and the Worker serves it at `https://mail.example.com/webmail/`. Its `config.json` comes from the Worker's vars, and bootstrap registers its OAuth client (`bulwark-lite`, redirect `https://mail.example.com/webmail/oauth/callback`).

## Notes

- A zone with Cloudflare bot protection may block uncommon user agents (we saw `Python-urllib` get 403). Scripts should send a normal `User-Agent`.
