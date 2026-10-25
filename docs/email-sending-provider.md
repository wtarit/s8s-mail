---
Last updated: 2026-10-25
---

# Considerations in choosing an outbound email provider

TL;DR: We need an outbound email provider that respects our Message-ID.

Per [RFC 5322](https://www.rfc-editor.org/info/rfc5322/), every message (aka every email) should have a Message-ID header, and its value must be globally unique. A reply should set the In-Reply-To header to the Message-ID of the email being replied to, and the References header to the parent's References followed by the parent's Message-ID, which lists every earlier email in its chain.

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

The email client uses this information to show all emails in the thread. So we need an outbound email provider that doesn't override our Message-ID. If it gets overridden, recipients who reply to our email will set In-Reply-To to the Message-ID of the email they received, which is different from the one we have stored. It is true that we could potentially read back the generated Message-ID, but that would make our sending flow more complicated.

Now let's consider each provider.

## Cloudflare Email Service

Initially, this sounds like the obvious choice, but it has two main issues:

1. It requires Workers Paid (min $5 per month), which negates the point of this project.
2. It generates its own Message-ID ([docs](https://developers.cloudflare.com/email-service/reference/headers/#platform-controlled-headers)).

## Amazon SES (and Resend etc.)

This also includes providers that are SES wrappers, like Resend.

According to Amazon SES, the Message-ID header will be overridden ([docs](https://docs.aws.amazon.com/ses/latest/dg/header-fields.html#:~:text=If%20you%20provide%20a%20Message%2DID%20header%2C%20Amazon%20SES%20overrides%20the%20header%20with%20its%20own%20value.)).

## Mailgun

This brings us to the only email provider we currently support, as it lets us freely set our own Message-ID.
