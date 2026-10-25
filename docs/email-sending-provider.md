---
Last updated: 2026-10-25
---

# Consideration in choosing outbound email provider

TLDR: We need a outbound email provider that respect our Message-ID.

So per [RFC 5322](https://www.rfc-editor.org/info/rfc5322/), it require each message (aka each email) to have a unique Message-ID header, then a reply work by setting In-Reply-To header to the Message-ID of the email you want to reply to and References header listing all previous email in the thread

For example:
```
A  Message-ID:  <a@alice.example>                       (starts the thread)

B  Message-ID:  <b@bob.example>
   In-Reply-To: <a@alice.example>
   References:  <a@alice.example>

C  Message-ID:  <c@alice.example>
   In-Reply-To: <b@bob.example>
   References:  <a@alice.example> <b@bob.example>
```

Which the email client can use this information to show all email in the email thread. So we need outbound email provider that doesn't override our Message-ID as if it get override, when recipient reply to our email, they will be setting In-Reply-To to the email they receive, which is different from what we have stored. It is true that we can potentially read back the Message-ID that get generated but that would make our sending flow more complicated.

Now let consider each provider

## Cloudflare Email Service

Initially, this sound like the obvious choice but it have two main issue.

1. It require worker paid (min $5 per month) with negate the point of this project
2. It generate its own Message-ID [docs](https://developers.cloudflare.com/email-service/reference/headers/#platform-controlled-headers)

## Amazon SES (and Resend etc.)

This also include provider that's a SES wrapper like Resend. 

Based on Amazon SES, the Message-ID header will be overrided [docs](https://docs.aws.amazon.com/ses/latest/dg/header-fields.html#:~:text=If%20you%20provide%20a%20Message%2DID%20header%2C%20Amazon%20SES%20overrides%20the%20header%20with%20its%20own%20value.)

## Mailgun

This bring us to the only email provider we currently support as it let us freely set our own Message-ID.
