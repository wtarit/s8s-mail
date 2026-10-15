import { describe, expect, it, vi } from "vitest";
import { CloudflareProvider, SendError, getSendProvider, mapCloudflareError } from "../../src/send";

const raw = new TextEncoder().encode("From: a@example.com\r\nTo: b@example.com\r\n\r\nhi\r\n");

interface Sent {
  from: string;
  to: string;
  raw: Uint8Array;
}

function fakeBinding(behaviour?: (n: number, to: string) => unknown) {
  const sent: Sent[] = [];
  const binding = {
    send: vi.fn(async (message: EmailMessage) => {
      const n = sent.length;
      // workerd's EmailMessage keeps the body under an internal property.
      const body = (message as unknown as Record<string, unknown>)["EmailMessage::raw"];
      const bytes = new Uint8Array(await new Response(body as BodyInit).arrayBuffer());
      sent.push({ from: message.from, to: message.to, raw: bytes });
      const out = behaviour?.(n, message.to);
      if (out instanceof Error) throw out;
      return (out ?? { messageId: `id-${n}` }) as EmailSendResult;
    }),
  } as unknown as SendEmail;
  return { binding, sent };
}

function cfError(code: string, message = "boom") {
  return Object.assign(new Error(message), { code });
}

describe("CloudflareProvider", () => {
  it("sends once per recipient through the EMAIL binding", async () => {
    const { binding, sent } = fakeBinding();
    const p = new CloudflareProvider({ binding });
    expect(p.maxMessageBytes).toBe(5 * 1024 * 1024);
    expect(p.maxRecipients).toBe(50);
    const res = await p.send({
      mailFrom: "a@example.com",
      rcptTo: ["b@example.com", "c@example.com", "d@example.com"],
      raw,
    });
    expect(res).toEqual({ providerMessageId: "id-0" });
    expect(sent.map((s) => s.to)).toEqual(["b@example.com", "c@example.com", "d@example.com"]);
    for (const s of sent) {
      expect(s.from).toBe("a@example.com");
      expect(s.raw).toEqual(raw);
    }
  });

  it("enforces 5 MiB and 50 recipients without calling the binding", async () => {
    const { binding } = fakeBinding();
    const p = new CloudflareProvider({ binding });
    await expect(
      p.send({
        mailFrom: "a@example.com",
        rcptTo: ["b@example.com"],
        raw: new Uint8Array(5 * 1024 * 1024 + 1),
      }),
    ).rejects.toMatchObject({ code: "tooLarge", retryable: false });
    await expect(
      p.send({
        mailFrom: "a@example.com",
        rcptTo: Array.from({ length: 51 }, (_, i) => `r${i}@example.com`),
        raw,
      }),
    ).rejects.toMatchObject({ code: "tooManyRecipients", retryable: false });
    expect(binding.send).not.toHaveBeenCalled();
    // Exactly at the limits is fine.
    await p.send({
      mailFrom: "a@example.com",
      rcptTo: Array.from({ length: 50 }, (_, i) => `r${i}@example.com`),
      raw: new Uint8Array(5 * 1024 * 1024),
    });
    expect(binding.send).toHaveBeenCalledTimes(50);
  });

  it("fails with a clear non-retryable error when the binding is missing", async () => {
    const p = new CloudflareProvider({ binding: undefined });
    const err = await p
      .send({ mailFrom: "a@example.com", rcptTo: ["b@example.com"], raw })
      .catch((e) => e);
    expect(err).toBeInstanceOf(SendError);
    expect(err).toMatchObject({ retryable: false, code: "notConfigured" });
    expect(err.message).toMatch(/Workers Paid/);
    expect(err.message).toMatch(/send_email/);
  });

  it("maps E_* codes to retryable / permanent", () => {
    for (const code of [
      "E_RATE_LIMIT_EXCEEDED",
      "E_DAILY_LIMIT_EXCEEDED",
      "E_INTERNAL_SERVER_ERROR",
    ]) {
      expect(mapCloudflareError(cfError(code))).toMatchObject({ retryable: true, code });
    }
    for (const code of [
      "E_VALIDATION_ERROR",
      "E_FIELD_MISSING",
      "E_TOO_MANY_RECIPIENTS",
      "E_SENDER_NOT_VERIFIED",
      "E_RECIPIENT_NOT_ALLOWED",
      "E_RECIPIENT_SUPPRESSED",
      "E_SENDER_DOMAIN_NOT_AVAILABLE",
      "E_CONTENT_TOO_LARGE",
      "E_DELIVERY_FAILED",
      "E_HEADER_NOT_ALLOWED",
      "E_HEADERS_TOO_LARGE",
      "E_SOMETHING_NEW",
    ]) {
      expect(mapCloudflareError(cfError(code))).toMatchObject({ retryable: false, code });
    }
    expect(mapCloudflareError(new Error("socket hang up"))).toMatchObject({ retryable: true });
  });

  it("surfaces binding errors, and reports partial delivery as non-retryable", async () => {
    const first = fakeBinding(() => cfError("E_RATE_LIMIT_EXCEEDED", "slow down"));
    const err1 = await new CloudflareProvider({ binding: first.binding })
      .send({ mailFrom: "a@example.com", rcptTo: ["b@example.com", "c@example.com"], raw })
      .catch((e) => e);
    expect(err1).toMatchObject({ retryable: true, code: "E_RATE_LIMIT_EXCEEDED" });
    expect(first.sent).toHaveLength(1);

    const second = fakeBinding((n) => (n === 1 ? cfError("E_INTERNAL_SERVER_ERROR") : undefined));
    const err2 = await new CloudflareProvider({ binding: second.binding })
      .send({
        mailFrom: "a@example.com",
        rcptTo: ["b@example.com", "c@example.com", "d@example.com"],
        raw,
      })
      .catch((e) => e);
    expect(err2).toMatchObject({ retryable: false, code: "partial" });
    expect(err2.message).toContain("1 of 3");
    expect(second.sent).toHaveLength(2);
  });

  it("is selected by MAIL_PROVIDER=cloudflare and uses env.EMAIL", async () => {
    const { binding, sent } = fakeBinding();
    const p = getSendProvider({
      MAIL_PROVIDER: "cloudflare",
      MAILGUN_REGION: "us",
      MAILGUN_DOMAIN: "mg.example.com",
      SYSTEM_MAIL_FROM: "no-reply@example.com",
      EMAIL: binding,
    } as unknown as Env);
    await p.send({ mailFrom: "a@example.com", rcptTo: ["b@example.com"], raw });
    expect(sent).toHaveLength(1);
  });
});
