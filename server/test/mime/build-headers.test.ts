import { describe, expect, it } from "vitest";
import { BlobNotFoundError, MimeBuildError, buildMime } from "../../src/mime";
import { baseEmail, baseOptions, blobStore, headerSection, parse, rawText } from "../helpers/mime";

describe("buildMime", () => {
  it("encodes Thai subject and display names", async () => {
    const { raw } = await buildMime(
      {
        ...baseEmail,
        from: [{ name: "สมชาย ใจดี", email: "somchai@example.com" }],
        to: [
          { name: "สมหญิง", email: "somying@example.com" },
          { name: 'Smith, "Bob"', email: "bob@example.com" },
          { name: "Plain Name", email: "plain@example.com" },
        ],
        subject: "ทดสอบการส่งอีเมลภาษาไทย ✓",
        bodyValues: { t: { value: "สวัสดีครับ\nนี่คือข้อความทดสอบ" } },
      },
      baseOptions,
    );
    const head = headerSection(raw);
    expect(head).toMatch(/^From: =\?UTF-8\?[BQ]\?/m);
    expect(head).toContain('"Smith, \\"Bob\\"" <bob@example.com>');
    expect(head).toContain("Plain Name <plain@example.com>");
    expect(rawText(raw)).toContain("Content-Transfer-Encoding: quoted-printable");
    expect(/[^\p{ASCII}]/u.test(rawText(raw))).toBe(false);
    for (const line of rawText(raw).split("\r\n")) expect(line.length).toBeLessThanOrEqual(78);
    const m = await parse(raw);
    expect(m.from).toEqual({ name: "สมชาย ใจดี", address: "somchai@example.com" });
    expect(m.to).toEqual([
      { name: "สมหญิง", address: "somying@example.com" },
      { name: 'Smith, "Bob"', address: "bob@example.com" },
      { name: "Plain Name", address: "plain@example.com" },
    ]);
    expect(m.subject).toBe("ทดสอบการส่งอีเมลภาษาไทย ✓");
    expect(m.text?.trim()).toBe("สวัสดีครับ\nนี่คือข้อความทดสอบ");
  });

  it("folds very long subjects and long recipient lists", async () => {
    const asciiSubject = Array.from({ length: 60 }, (_, i) => `word${i}`).join(" ");
    const thaiSubject = "ทดสอบ".repeat(60);
    const many = Array.from({ length: 30 }, (_, i) => ({
      name: `Recipient ${i}`,
      email: `r${i}@example.com`,
    }));
    for (const subject of [asciiSubject, thaiSubject, "mixed ทดสอบ ".repeat(20).trim()]) {
      const { raw } = await buildMime({ ...baseEmail, subject, to: many }, baseOptions);
      for (const line of headerSection(raw).split("\r\n"))
        expect(line.length).toBeLessThanOrEqual(78);
      const m = await parse(raw);
      expect(m.subject).toBe(subject);
      expect(m.to).toHaveLength(30);
      expect(m.to![29]).toEqual({ name: "Recipient 29", address: "r29@example.com" });
    }
  });

  it("encodes long body lines with quoted-printable and keeps content intact", async () => {
    const longLine = "x".repeat(3000) + " é " + "y".repeat(100);
    const body = `${longLine}\n\ntrailing space \nline with = sign\n.dot first`;
    const { raw } = await buildMime(
      { ...baseEmail, bodyValues: { t: { value: body } } },
      baseOptions,
    );
    for (const line of rawText(raw).split("\r\n")) expect(line.length).toBeLessThanOrEqual(76);
    const m = await parse(raw);
    expect(m.text?.replace(/\r\n/g, "\n").trim()).toBe(body);
  });

  it("normalises line endings and avoids boundaries inside content", async () => {
    const { raw } = await buildMime(
      {
        ...baseEmail,
        bodyValues: { t: { value: "a\rb\nc\r\nd" }, h: { value: "<p>h</p>" } },
        htmlBody: [{ partId: "h" }],
      },
      baseOptions,
    );
    expect(rawText(raw)).not.toMatch(/[^\r]\n|\r[^\n]/);
    const m = await parse(raw);
    expect(m.text?.trim().replace(/\r\n/g, "\n")).toBe("a\nb\nc\nd");
  });

  it("includes Bcc only when asked", async () => {
    const email = { ...baseEmail, bcc: [{ name: "Hidden", email: "hidden@example.com" }] };
    const without = await buildMime(email, baseOptions);
    expect(rawText(without.raw)).not.toMatch(/^Bcc:/im);
    expect(rawText(without.raw)).not.toContain("hidden@example.com");
    const withBcc = await buildMime(email, { ...baseOptions, includeBcc: true });
    expect(headerSection(withBcc.raw)).toContain("Bcc: Hidden <hidden@example.com>");
    expect((await parse(withBcc.raw)).bcc).toEqual([
      { name: "Hidden", address: "hidden@example.com" },
    ]);
  });

  it("writes Cc, Reply-To, Sender, In-Reply-To and References", async () => {
    const { raw } = await buildMime(
      {
        ...baseEmail,
        cc: [{ email: "cc@example.com" }],
        replyTo: [{ name: "Reply Desk", email: "reply@example.com" }],
        sender: [{ email: "sender@example.com" }],
        inReplyTo: ["parent@example.org"],
        references: ["root@example.org", "<parent@example.org>"],
      },
      baseOptions,
    );
    const head = headerSection(raw);
    expect(head).toContain("In-Reply-To: <parent@example.org>");
    expect(head).toContain("References: <root@example.org> <parent@example.org>");
    const m = await parse(raw);
    expect(m.cc).toEqual([{ name: "", address: "cc@example.com" }]);
    expect(m.replyTo).toEqual([{ name: "Reply Desk", address: "reply@example.com" }]);
    expect(m.sender).toEqual({ name: "", address: "sender@example.com" });
    expect(m.inReplyTo).toBe("<parent@example.org>");
    expect(m.references).toBe("<root@example.org> <parent@example.org>");
  });

  it("folds a long References chain within 78 columns", async () => {
    const references = Array.from({ length: 40 }, (_, i) => `msg${i}.abcdef@mail.example.org`);
    const { raw } = await buildMime({ ...baseEmail, references }, baseOptions);
    for (const line of headerSection(raw).split("\r\n"))
      expect(line.length).toBeLessThanOrEqual(78);
    expect((await parse(raw)).references).toBe(references.map((r) => `<${r}>`).join(" "));
  });

  it("adds custom headers, drops reserved ones and neutralises CRLF injection", async () => {
    const { raw } = await buildMime(
      {
        ...baseEmail,
        headers: [
          { name: "X-Custom", value: "one\r\nBcc: evil@example.com" },
          { name: "Subject", value: "ignored" },
          { name: "Content-Type", value: "text/evil" },
          { name: "bad name", value: "x" },
          { name: "List-Unsubscribe", value: "<https://example.com/u>" },
        ],
      },
      baseOptions,
    );
    const head = headerSection(raw);
    expect(head).toContain("X-Custom: one Bcc: evil@example.com");
    expect(head).not.toMatch(/^Bcc:/m);
    expect(head).not.toContain("ignored");
    expect(head).not.toContain("text/evil");
    expect(head).toContain("List-Unsubscribe: <https://example.com/u>");
  });

  it("rejects invalid addresses, missing From and missing body values", async () => {
    await expect(
      buildMime(
        { ...baseEmail, to: [{ email: "a@example.com>\r\nBcc: x@example.com" }] },
        baseOptions,
      ),
    ).rejects.toBeInstanceOf(MimeBuildError);
    await expect(buildMime({ ...baseEmail, from: [] }, baseOptions)).rejects.toMatchObject({
      property: "from",
    });
    await expect(
      buildMime({ ...baseEmail, textBody: [{ partId: "nope" }] }, baseOptions),
    ).rejects.toMatchObject({ code: "invalidProperties", property: "textBody" });
  });

  it("punycodes internationalised domains", async () => {
    const { raw } = await buildMime(
      { ...baseEmail, to: [{ email: "user@bücher.example" }] },
      baseOptions,
    );
    expect(headerSection(raw)).toContain("To: user@xn--bcher-kva.example");
  });

  it("throws BlobNotFoundError for unknown blobs", async () => {
    const promise = buildMime(
      { ...baseEmail, attachments: [{ blobId: "missing", type: "text/plain", name: "a.txt" }] },
      baseOptions,
    );
    await expect(promise).rejects.toBeInstanceOf(BlobNotFoundError);
    await expect(promise).rejects.toMatchObject({ blobId: "missing" });
  });

  it("builds a 3 MiB attachment message quickly", async () => {
    const data = new Uint8Array(3 * 1024 * 1024).map((_, i) => (i * 31) % 256);
    const t0 = performance.now();
    const { raw } = await buildMime(
      {
        ...baseEmail,
        attachments: [{ blobId: "big", type: "application/octet-stream", name: "big.bin" }],
      },
      { ...baseOptions, fetchBlob: blobStore({ big: data }) },
    );
    const ms = performance.now() - t0;
    console.log(`buildMime 3 MiB attachment: ${ms.toFixed(1)} ms wall, ${raw.length} bytes`);
    expect(raw.length).toBeGreaterThan(data.length);
    expect(raw.length).toBeLessThan(Math.ceil(data.length * 1.37) + 2000);
  });
});
