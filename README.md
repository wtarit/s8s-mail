# s8s-mail
S(erveles)s Mail - Email server on Cloudflare worker.

## Background
I want a low (or ideally) no maintainance email server that have $0 running cost. It need to be usable in Cloudflare worker free tier because for worker paid, the minimum is $5 and at that price you can get a VPS and run [mail-in-a-box](https://github.com/mail-in-a-box/mailinabox) or [stalwart](https://stalw.art/).

> 

## Features
- Receive email from Cloudflare Email Routing
- Multi-user support
- Store email in Durable Object (one Durable Object per account), email attachment in R2
- Provide inbox over JMAP
- Send Email via Mailgun HTTP API
- Admin dashboard for user management

## Compromise

