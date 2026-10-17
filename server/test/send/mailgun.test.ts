import { describe, expect, it, vi } from "vitest";
import { MailgunProvider, SendError, getSendProvider } from "../../src/send";

const raw = new TextEncoder().encode("From: a@example.com\r\nTo: b@example.com\r\n\r\nhi\r\n");

function mockFetch(status: number, body: unknown) {
  return vi.fn(
    async (_url: string | URL | Request, _init?: RequestInit) =>
      new Response(typeof body === "string" ? body : JSON.stringify(body), { status }),
  );
}

function provider(region: "us" | "eu", fetchFn: typeof fetch, apiKey: string | null = "key-test") {
  return new MailgunProvider({
    apiKey: apiKey ?? undefined,
    domain: "mg.example.com",
    region,
    fetch: fetchFn,
  });
}

describe("MailgunProvider", () => {
  it("posts raw MIME with auth, one `to` per recipient, and returns the id (US)", async () => {
    const f = mockFetch(200, {
      id: "<20261012.abc@mg.example.com>",
      message: "Queued. Thank you.",
    });
    const p = provider("us", f as unknown as typeof fetch);
    expect(p.maxMessageBytes).toBe(25_000_000);
    expect(p.maxRecipients).toBe(1000);
    const res = await p.send({
      mailFrom: "a@example.com",
      rcptTo: ["b@example.com", "c@example.com", "hidden@example.com"],
      raw,
    });
    expect(res).toEqual({ providerMessageId: "<20261012.abc@mg.example.com>" });
    expect(f).toHaveBeenCalledTimes(1);
    const [url, init] = f.mock.calls[0]!;
    expect(url).toBe("https://api.mailgun.net/v3/mg.example.com/messages.mime");
    expect(init!.method).toBe("POST");
    expect((init!.headers as Record<string, string>).Authorization).toBe(
      "Basic " + btoa("api:key-test"),
    );
    const form = init!.body as FormData;
    expect(form.getAll("to")).toEqual(["b@example.com", "c@example.com", "hidden@example.com"]);
    const file = form.get("message") as File;
    expect(file).toBeInstanceOf(Blob);
    expect(new Uint8Array(await file.arrayBuffer())).toEqual(raw);
  });

  it("uses the EU host for the eu region", async () => {
    const f = mockFetch(200, { id: "<x>" });
    await provider("eu", f as unknown as typeof fetch).send({
      mailFrom: "a@example.com",
      rcptTo: ["b@example.com"],
      raw,
    });
    expect(f.mock.calls[0]![0]).toBe("https://api.eu.mailgun.net/v3/mg.example.com/messages.mime");
  });

  it.each([
    [400, false],
    [401, false],
    [403, false],
    [404, false],
    [413, false],
    [408, true],
    [429, true],
    [500, true],
    [503, true],
  ])("maps HTTP %i to retryable=%s", async (status, retryable) => {
    const f = mockFetch(status, { message: "nope" });
    const err = await provider("us", f as unknown as typeof fetch)
      .send({ mailFrom: "a@example.com", rcptTo: ["b@example.com"], raw })
      .catch((e) => e);
    expect(err).toBeInstanceOf(SendError);
    expect(err.retryable).toBe(retryable);
    expect(err.code).toBe(`mailgun_${status}`);
    expect(err.message).toContain("nope");
    expect(err.message).not.toContain("key-test");
  });

  it("treats network failures as retryable and tolerates non-JSON error bodies", async () => {
    const boom = vi.fn(async () => {
      throw new TypeError("connection reset");
    });
    const err = await provider("us", boom as unknown as typeof fetch)
      .send({ mailFrom: "a@example.com", rcptTo: ["b@example.com"], raw })
      .catch((e) => e);
    expect(err).toMatchObject({ retryable: true, code: "network" });

    const html = mockFetch(502, "<html>bad gateway</html>");
    const err2 = await provider("us", html as unknown as typeof fetch)
      .send({ mailFrom: "a@example.com", rcptTo: ["b@example.com"], raw })
      .catch((e) => e);
    expect(err2).toMatchObject({ retryable: true, code: "mailgun_502" });
  });

  it("enforces size and recipient limits before calling the API", async () => {
    const f = mockFetch(200, { id: "<x>" });
    const p = provider("us", f as unknown as typeof fetch);
    await expect(
      p.send({
        mailFrom: "a@example.com",
        rcptTo: ["b@example.com"],
        raw: new Uint8Array(25_000_001),
      }),
    ).rejects.toMatchObject({ code: "tooLarge", retryable: false });
    await expect(
      p.send({
        mailFrom: "a@example.com",
        rcptTo: Array.from({ length: 1001 }, (_, i) => `r${i}@example.com`),
        raw,
      }),
    ).rejects.toMatchObject({ code: "tooManyRecipients", retryable: false });
    await expect(p.send({ mailFrom: "a@example.com", rcptTo: [], raw })).rejects.toMatchObject({
      code: "noRecipients",
    });
    expect(f).not.toHaveBeenCalled();
  });

  it("fails clearly without the MAILGUN_API secret", async () => {
    const f = mockFetch(200, { id: "<x>" });
    await expect(
      provider("us", f as unknown as typeof fetch, null).send({
        mailFrom: "a@example.com",
        rcptTo: ["b@example.com"],
        raw,
      }),
    ).rejects.toMatchObject({ code: "notConfigured", retryable: false });
    expect(f).not.toHaveBeenCalled();
  });
});

const env = (over: Record<string, unknown>) =>
  ({
    MAIL_PROVIDER: "mailgun",
    MAILGUN_REGION: "us",
    MAILGUN_DOMAIN: "mg.example.com",
    SYSTEM_MAIL_FROM: "S8S Mail <no-reply@example.com>",
    ...over,
  }) as unknown as Env;

describe("getSendProvider", () => {
  it("selects by MAIL_PROVIDER", () => {
    expect(getSendProvider(env({})).name).toBe("mailgun");
    expect(() => getSendProvider(env({ MAIL_PROVIDER: "sendgrid" }))).toThrow(SendError);
  });

  it("builds the region from MAILGUN_REGION and the key from MAILGUN_API", async () => {
    const f = vi.fn(async (_u: string | URL | Request, _i?: RequestInit) =>
      Response.json({ id: "<i>" }),
    );
    vi.stubGlobal("fetch", f);
    try {
      const p = getSendProvider(env({ MAILGUN_REGION: "eu", MAILGUN_API: "key-env" }));
      await p.send({ mailFrom: "a@example.com", rcptTo: ["b@example.com"], raw });
      expect(f.mock.calls[0]![0]).toContain("https://api.eu.mailgun.net/v3/mg.example.com/");
      expect((f.mock.calls[0]![1]!.headers as Record<string, string>).Authorization).toBe(
        "Basic " + btoa("api:key-env"),
      );
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
