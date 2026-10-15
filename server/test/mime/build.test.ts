import { describe, expect, it } from "vitest";
import { buildMime } from "../../src/mime";
import {
  baseEmail,
  baseOptions,
  blobStore,
  enc,
  headerSection,
  parse,
  rawText,
} from "../helpers/mime";

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
});
