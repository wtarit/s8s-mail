import PostalMime from "postal-mime";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MailgunProvider, maxAttachmentBytes, parseMailbox, sendSystemMail } from "../../src/send";
import { buildMime } from "../../src/mime";

afterEach(() => vi.unstubAllGlobals());

const env = (over: Record<string, unknown> = {}) =>
  ({
    MAIL_PROVIDER: "mailgun",
    MAILGUN_REGION: "us",
    MAILGUN_DOMAIN: "mg.example.com",
    MAIL_PROVIDER_API_KEY: "key-test",
    SYSTEM_MAIL_FROM: "S8S Mail <no-reply@example.com>",
    ...over,
  }) as unknown as Env;

describe("sendSystemMail", () => {
  it("builds a text+html message from SYSTEM_MAIL_FROM and posts it to Mailgun", async () => {
    const f = vi.fn(async (_u: string | URL | Request, _i?: RequestInit) =>
      Response.json({ id: "<sys@mg.example.com>", message: "Queued." }),
    );
    vi.stubGlobal("fetch", f);
    await sendSystemMail(env(), {
      to: "recovery@example.com",
      subject: "Your sign-in link ✓",
      text: "Open https://example.com/magic?token=abc",
      html: '<p>Open <a href="https://example.com/magic?token=abc">the link</a></p>',
    });
    expect(f).toHaveBeenCalledTimes(1);
    const [url, init] = f.mock.calls[0]!;
    expect(url).toBe("https://api.mailgun.net/v3/mg.example.com/messages.mime");
    const form = init!.body as FormData;
    expect(form.getAll("to")).toEqual(["recovery@example.com"]);
    const msg = await PostalMime.parse(await (form.get("message") as File).arrayBuffer());
    expect(msg.from).toEqual({ name: "S8S Mail", address: "no-reply@example.com" });
    expect(msg.to).toEqual([{ name: "", address: "recovery@example.com" }]);
    expect(msg.subject).toBe("Your sign-in link ✓");
    expect(msg.text).toContain("https://example.com/magic?token=abc");
    expect(msg.html).toContain("the link");
    expect(msg.messageId).toMatch(/@example\.com>$/);
    expect(msg.headers.find((h) => h.key === "auto-submitted")?.value).toBe("auto-generated");
  });

  it("propagates provider failures as SendError", async () => {
    vi.stubGlobal("fetch", async () => Response.json({ message: "Forbidden" }, { status: 403 }));
    await expect(
      sendSystemMail(env(), { to: "recovery@example.com", subject: "s", text: "t" }),
    ).rejects.toMatchObject({ name: "SendError", retryable: false, code: "mailgun_403" });
  });

  it("rejects header-injection attempts in the recipient", async () => {
    vi.stubGlobal("fetch", vi.fn());
    await expect(
      sendSystemMail(env(), { to: "a@example.com\r\nBcc: x@example.com", subject: "s", text: "t" }),
    ).rejects.toMatchObject({ name: "MimeBuildError" });
  });
});

describe("parseMailbox", () => {
  it("parses name-addr and bare forms", () => {
    expect(parseMailbox("S8S Mail <no-reply@example.com>")).toEqual({
      name: "S8S Mail",
      email: "no-reply@example.com",
    });
    expect(parseMailbox('"Mail, Inc." <a@example.com>')).toEqual({
      name: "Mail, Inc.",
      email: "a@example.com",
    });
    expect(parseMailbox("<a@example.com>")).toEqual({ name: null, email: "a@example.com" });
    expect(parseMailbox(" a@example.com ")).toEqual({ name: null, email: "a@example.com" });
  });
});

describe("maxAttachmentBytes", () => {
  const mailgun = new MailgunProvider({ apiKey: "k", domain: "d.example.com", region: "us" });

  it("computes the advertised limit", () => {
    expect(maxAttachmentBytes(mailgun)).toBe(18_173_445);
  });

  it("real messages with several attachments at the limit stay under the provider's limit", async () => {
    const limit = maxAttachmentBytes(mailgun);
    const n = 8;
    const blob = new Uint8Array(Math.floor(limit / n)).map((_, i) => i % 251);
    const { size } = await buildMime(
      {
        from: [{ email: "a@example.com" }],
        to: [{ email: "b@example.com" }],
        subject: "big",
        bodyValues: { t: { value: "x".repeat(50_000) } },
        textBody: [{ partId: "t" }],
        attachments: Array.from({ length: n }, (_, i) => ({
          blobId: "b",
          type: "application/octet-stream",
          name: `file-${i}-${"ä".repeat(20)}.bin`,
        })),
      },
      { fetchBlob: async () => blob, messageIdDomain: "example.com", includeBcc: true },
    );
    expect(size).toBeLessThanOrEqual(mailgun.maxMessageBytes);
  });
});
