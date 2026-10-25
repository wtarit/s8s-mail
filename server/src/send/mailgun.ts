import { BaseProvider } from "./base";
import type { OutboundMessage, SendResult } from "./types";
import { SendError } from "./types";

export interface MailgunConfig {
  apiKey: string | undefined;
  domain: string;
  region: "us" | "eu";
  /** Defaults to the global `fetch` (looked up at call time). */
  fetch?: typeof fetch;
}

/** Mailgun raw-MIME sending: `POST /v3/{domain}/messages.mime`. */
export class MailgunProvider extends BaseProvider {
  readonly name = "mailgun" as const;
  readonly maxMessageBytes = 25_000_000;
  readonly maxRecipients = 1000;

  constructor(private readonly config: MailgunConfig) {
    super();
  }

  get endpoint(): string {
    const host = this.config.region === "eu" ? "api.eu.mailgun.net" : "api.mailgun.net";
    return `https://${host}/v3/${encodeURIComponent(this.config.domain)}/messages.mime`;
  }

  protected async deliver(message: OutboundMessage): Promise<SendResult> {
    const { apiKey } = this.config;
    if (!apiKey) {
      throw new SendError(
        "Mailgun is selected but the MAIL_PROVIDER_API_KEY secret is not set",
        false,
        "notConfigured",
      );
    }
    const form = new FormData();
    for (const rcpt of message.rcptTo) form.append("to", rcpt);
    form.append("message", new Blob([message.raw], { type: "message/rfc822" }), "message.mime");

    const doFetch = this.config.fetch ?? ((input, init) => fetch(input, init));
    let res: Response;
    try {
      res = await doFetch(this.endpoint, {
        method: "POST",
        headers: { Authorization: "Basic " + btoa(`api:${apiKey}`) },
        body: form,
      });
    } catch (err) {
      throw new SendError(
        `Mailgun request failed: ${err instanceof Error ? err.message : String(err)}`,
        true,
        "network",
      );
    }

    let body: { id?: unknown; message?: unknown } = {};
    try {
      body = (await res.json()) as typeof body;
    } catch {
      /* non-JSON body */
    }
    if (res.ok) {
      return typeof body.id === "string" ? { providerMessageId: body.id } : {};
    }
    const detail = typeof body.message === "string" ? `: ${body.message.slice(0, 200)}` : "";
    // 429 and 5xx (and 408) are transient; 400/401/403/404/413 etc. will not improve on retry.
    const retryable = res.status === 429 || res.status === 408 || res.status >= 500;
    throw new SendError(
      `Mailgun responded ${res.status}${detail}`,
      retryable,
      `mailgun_${res.status}`,
    );
  }
}
