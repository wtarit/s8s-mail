import { describe, expect, it } from "vitest";
import { BlobNotFoundError, MimeBuildError, buildMime } from "../src/mime";
import {
  baseEmail,
  baseOptions,
  blobStore,
  enc,
  headerSection,
  parse,
  rawText,
} from "./mime-helpers";

describe("buildMime", () => {
  it("builds a plain text message", async () => {
    const { raw, messageId, size } = await buildMime(baseEmail, baseOptions);
    expect(size).toBe(raw.length);
    const text = rawText(raw);
    expect(text).toContain("Date: Mon, 12 Oct 2026 08:30:00 +0000\r\n");
    expect(text).toContain("MIME-Version: 1.0\r\n");
    expect(text).toContain(`Message-ID: <${messageId}>\r\n`);
    expect(messageId).toMatch(/^[a-z0-9.]+@example\.com$/);
    expect(text).toContain("Content-Type: text/plain; charset=utf-8\r\n");
    expect(text).toContain("Content-Transfer-Encoding: 7bit\r\n");
    expect(text).not.toContain("\n\n");
    expect(text.replace(/\r\n/g, "")).not.toMatch(/[\r\n]/);
    const m = await parse(raw);
    expect(m.from).toEqual({ name: "Alice Example", address: "alice@example.com" });
    expect(m.to).toEqual([{ name: "", address: "bob@example.com" }]);
    expect(m.subject).toBe("Hello");
    expect(m.text?.trim()).toBe("Hi Bob");
    expect(m.html).toBeUndefined();
    expect(m.attachments).toHaveLength(0);
    expect(m.messageId).toBe(`<${messageId}>`);
  });

  it("uses a provided Message-ID and sentAt", async () => {
    const { raw, messageId } = await buildMime(
      {
        ...baseEmail,
        messageId: ["abc123@client.example.com"],
        sentAt: "2026-01-02T03:04:05+07:00",
      },
      baseOptions,
    );
    expect(messageId).toBe("abc123@client.example.com");
    const t = rawText(raw);
    expect(t).toContain("Message-ID: <abc123@client.example.com>\r\n");
    expect(t).toContain("Date: Thu, 1 Jan 2026 20:04:05 +0000\r\n");
  });

  it("builds multipart/alternative for text + html", async () => {
    const { raw } = await buildMime(
      {
        ...baseEmail,
        bodyValues: { t: { value: "plain" }, h: { value: "<p>html é</p>" } },
        htmlBody: [{ partId: "h", type: "text/html" }],
      },
      baseOptions,
    );
    expect(headerSection(raw)).toContain("Content-Type: multipart/alternative;");
    const m = await parse(raw);
    expect(m.text?.trim()).toBe("plain");
    expect(m.html?.trim()).toBe("<p>html é</p>");
    expect(m.attachments).toHaveLength(0);
  });

  it("builds html-only messages", async () => {
    const { raw } = await buildMime(
      {
        ...baseEmail,
        textBody: undefined,
        bodyValues: { h: { value: "<b>x</b>" } },
        htmlBody: [{ partId: "h", type: "text/html" }],
      },
      baseOptions,
    );
    expect(headerSection(raw)).toContain("Content-Type: text/html; charset=utf-8");
    expect((await parse(raw)).html?.trim()).toBe("<b>x</b>");
  });

  it("puts inline cid images in multipart/related inside alternative", async () => {
    const png = Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 1, 2, 3, 4, 250, 251]);
    const { raw } = await buildMime(
      {
        ...baseEmail,
        bodyValues: { t: { value: "see image" }, h: { value: '<img src="cid:logo@example.com">' } },
        htmlBody: [{ partId: "h", type: "text/html" }],
        attachments: [
          {
            blobId: "b1",
            type: "image/png",
            name: "logo.png",
            disposition: "inline",
            cid: "logo@example.com",
          },
        ],
      },
      { ...baseOptions, fetchBlob: blobStore({ b1: png }) },
    );
    const text = rawText(raw);
    expect(text).toContain("Content-Type: multipart/alternative;");
    expect(text).toContain("Content-Type: multipart/related;");
    expect(text).not.toContain("multipart/mixed");
    expect(text).toContain("Content-ID: <logo@example.com>");
    const m = await parse(raw);
    expect(m.html).toContain("cid:logo@example.com");
    expect(m.attachments).toHaveLength(1);
    const a = m.attachments[0]!;
    expect(a.contentId).toBe("<logo@example.com>");
    expect(a.disposition).toBe("inline");
    expect(a.related).toBe(true);
    expect(new Uint8Array(a.content as ArrayBuffer)).toEqual(png);
  });

  it("puts regular attachments in multipart/mixed, with non-ASCII filenames (RFC 2231)", async () => {
    const data = new Uint8Array(1000).map((_, i) => i % 256);
    const pdf = enc.encode("%PDF-1.4 tiny");
    const { raw } = await buildMime(
      {
        ...baseEmail,
        attachments: [
          { blobId: "b1", type: "application/pdf", name: "สรุป.pdf", disposition: "attachment" },
          { blobId: "b2", type: "application/octet-stream", name: 'we"ird \\name.bin' },
          { blobId: "b3", type: "bad type", name: null },
          { blobId: "b4", type: "text/plain", name: `${"ยาว".repeat(40)}.txt` },
        ],
      },
      { ...baseOptions, fetchBlob: blobStore({ b1: pdf, b2: data, b3: data, b4: pdf }) },
    );
    const text = rawText(raw);
    expect(text).toContain("Content-Type: multipart/mixed;");
    expect(text).toContain("filename*=UTF-8''%E0%B8%AA");
    expect(text).toContain("filename*0*=UTF-8''");
    expect(text).toContain("filename*1*=");
    for (const line of text.split("\r\n")) expect(line.length).toBeLessThanOrEqual(78);
    const m = await parse(raw);
    expect(m.text?.trim()).toBe("Hi Bob");
    expect(m.attachments).toHaveLength(4);
    expect(m.attachments[0]!.filename).toBe("สรุป.pdf");
    expect(m.attachments[0]!.mimeType).toBe("application/pdf");
    expect(m.attachments[0]!.disposition).toBe("attachment");
    expect(new Uint8Array(m.attachments[0]!.content as ArrayBuffer)).toEqual(pdf);
    expect(m.attachments[1]!.filename).toBe('we"ird _name.bin');
    expect(new Uint8Array(m.attachments[1]!.content as ArrayBuffer)).toEqual(data);
    expect(m.attachments[2]!.mimeType).toBe("application/octet-stream");
    expect(m.attachments[3]!.filename).toBe(`${"ยาว".repeat(40)}.txt`);
  });

  it("base64 bodies are 76 columns and survive all remainder lengths", async () => {
    for (const len of [0, 1, 2, 3, 56, 57, 58, 113, 114, 115, 1000]) {
      const data = new Uint8Array(len).map((_, i) => (i * 7 + 3) % 256);
      const { raw } = await buildMime(
        { ...baseEmail, attachments: [{ blobId: "x", type: "application/zip", name: "a.zip" }] },
        { ...baseOptions, fetchBlob: blobStore({ x: data }) },
      );
      const lines = rawText(raw).split("\r\n");
      for (const l of lines) expect(l.length).toBeLessThanOrEqual(76);
      const m = await parse(raw);
      expect(new Uint8Array(m.attachments[0]!.content as ArrayBuffer)).toEqual(data);
    }
  });

  it("keeps inline attachments without html in multipart/mixed", async () => {
    const { raw } = await buildMime(
      {
        ...baseEmail,
        attachments: [
          { blobId: "b", type: "image/gif", name: "a.gif", disposition: "inline", cid: "c1" },
        ],
      },
      { ...baseOptions, fetchBlob: blobStore({ b: Uint8Array.of(1, 2, 3) }) },
    );
    const text = rawText(raw);
    expect(text).toContain("multipart/mixed");
    expect(text).not.toContain("multipart/related");
    expect(text).toContain("Content-ID: <c1>");
  });

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

describe("encoders", () => {
  it("base64Lines output is exactly sized and CRLF-terminated for every length", async () => {
    const { base64Lines } = await import("../src/mime/encode");
    for (let len = 1; len < 400; len++) {
      const data = new Uint8Array(len).map((_, i) => (i * 13 + len) % 256);
      const out = base64Lines(data);
      const text = new TextDecoder().decode(out);
      expect(text.endsWith("\r\n")).toBe(true);
      expect(text.includes("\0")).toBe(false);
      const lines = text.slice(0, -2).split("\r\n");
      for (const l of lines.slice(0, -1)) expect(l.length).toBe(76);
      expect(lines.at(-1)!.length).toBeLessThanOrEqual(76);
      const bin = atob(lines.join(""));
      expect(bin.length).toBe(len);
      expect(Uint8Array.from(bin, (c) => c.charCodeAt(0))).toEqual(data);
    }
  });
});
