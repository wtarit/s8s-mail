import { describe, expect, it } from "vitest";
import {
  decodeEncodedWords,
  decodeTextHeader,
  extractIngestHeaders,
  normalizeRecipient,
  parseAddressList,
  parseDateHeader,
  parseMessageIds,
} from "../../src/mail/headers";

describe("decodeEncodedWords", () => {
  it("decodes UTF-8 base64 (Thai)", () => {
    // "สวัสดี" in UTF-8, base64
    expect(decodeEncodedWords("=?UTF-8?B?4Liq4Lin4Lix4Liq4LiU4Li1?=")).toBe("สวัสดี");
  });

  it("decodes Q encoding with underscores and hex escapes", () => {
    expect(decodeEncodedWords("=?utf-8?Q?Caf=C3=A9_au_lait?=")).toBe("Café au lait");
  });

  it("decodes legacy charsets (TIS-620, ISO-8859-1)", () => {
    expect(decodeEncodedWords("=?TIS-620?B?oaI=?=")).toBe("กข");
    expect(decodeEncodedWords("=?iso-8859-1?Q?Andr=E9?=")).toBe("André");
  });

  it("joins adjacent words and ignores the whitespace between them, even mid-character", () => {
    // One UTF-8 character (ก = E0 B8 81) split across two encoded-words.
    expect(decodeEncodedWords("=?UTF-8?Q?=E0=B8?= =?UTF-8?Q?=81?=")).toBe("ก");
    expect(decodeEncodedWords("=?UTF-8?B?SGVsbG8=?=  =?UTF-8?B?V29ybGQ=?=")).toBe("HelloWorld");
  });

  it("keeps plain text around encoded words and leaves malformed words alone", () => {
    expect(decodeEncodedWords("Re: =?UTF-8?B?4LiB?= done")).toBe("Re: ก done");
    expect(decodeEncodedWords("=?UTF-8?B?***?=")).toBe("=?UTF-8?B?***?=");
    expect(decodeEncodedWords("no words")).toBe("no words");
  });
});

describe("decodeTextHeader", () => {
  it("unfolds, decodes and trims", () => {
    expect(decodeTextHeader("  =?UTF-8?B?4Liq4Lin4Lix4Liq4LiU4Li1?=\r\n  world ")).toBe(
      "สวัสดี world",
    );
  });

  it("recovers raw UTF-8 delivered as a byte string", () => {
    const raw = String.fromCharCode(...new TextEncoder().encode("Café"));
    expect(decodeTextHeader(raw)).toBe("Café");
  });

  it("returns null for absent or empty values", () => {
    expect(decodeTextHeader(null)).toBeNull();
    expect(decodeTextHeader("   ")).toBeNull();
  });
});

describe("parseAddressList", () => {
  it("parses bare addresses and angle-addr with display names", () => {
    expect(parseAddressList("ana@example.com, Bob Smith <bob@example.com>")).toEqual([
      { name: null, email: "ana@example.com" },
      { name: "Bob Smith", email: "bob@example.com" },
    ]);
  });

  it("handles quoted display names containing commas, quotes and escapes", () => {
    expect(
      parseAddressList('"Smith, Bob" <bob@example.com>, "Say \\"hi\\"" <hi@example.com>'),
    ).toEqual([
      { name: "Smith, Bob", email: "bob@example.com" },
      { name: 'Say "hi"', email: "hi@example.com" },
    ]);
  });

  it("decodes encoded-word display names (Thai) and legacy comments", () => {
    expect(parseAddressList("=?UTF-8?B?4Liq4Lin4Lix4Liq4LiU4Li1?= <th@example.com>")).toEqual([
      { name: "สวัสดี", email: "th@example.com" },
    ]);
    expect(parseAddressList("old@example.com (Old Style)")).toEqual([
      { name: "Old Style", email: "old@example.com" },
    ]);
  });

  it("flattens groups and drops empty ones", () => {
    expect(parseAddressList("Team: a@example.com, B <b@example.com>;, c@example.com")).toEqual([
      { name: null, email: "a@example.com" },
      { name: "B", email: "b@example.com" },
      { name: null, email: "c@example.com" },
    ]);
    expect(parseAddressList("undisclosed-recipients:;")).toEqual([]);
  });

  it("is tolerant: folded lines, comments, junk", () => {
    expect(parseAddressList("Ana (work)\r\n <ana@example.com>,\r\n not-an-address")).toEqual([
      { name: "Ana", email: "ana@example.com" },
    ]);
    expect(parseAddressList(null)).toEqual([]);
    expect(parseAddressList("")).toEqual([]);
  });
});

describe("message ids and dates", () => {
  it("extracts ids without brackets", () => {
    expect(parseMessageIds(" <a@example.com>\r\n <b@example.com> ")).toEqual([
      "a@example.com",
      "b@example.com",
    ]);
    expect(parseMessageIds(null)).toEqual([]);
  });

  it("parses RFC 5322 dates, with trailing comments", () => {
    expect(parseDateHeader("Mon, 12 Oct 2026 10:00:00 +0700 (ICT)")).toBe(
      Date.UTC(2026, 9, 12, 3, 0, 0),
    );
    expect(parseDateHeader("garbage")).toBeNull();
  });
});

describe("normalizeRecipient", () => {
  it("lowercases and strips +tag", () => {
    expect(normalizeRecipient("Ana+Newsletters@Example.COM")).toBe("ana@example.com");
    expect(normalizeRecipient("<ana@example.com>")).toBe("ana@example.com");
    expect(normalizeRecipient("+odd@example.com")).toBe("+odd@example.com");
  });
});

describe("extractIngestHeaders", () => {
  it("maps a Headers object to ingest fields", () => {
    const h = new Headers({
      "Message-ID": "<m@example.com>",
      "In-Reply-To": "<p@example.com>",
      References: "<r1@example.com> <p@example.com>",
      Subject: "=?UTF-8?B?4Liq4Lin4Lix4Liq4LiU4Li1?=",
      Date: "Mon, 12 Oct 2026 10:00:00 +0000",
      From: "Bob <bob@example.com>",
      To: "ana@example.com",
    });
    expect(extractIngestHeaders(h)).toMatchObject({
      messageId: "m@example.com",
      inReplyTo: ["p@example.com"],
      references: ["r1@example.com", "p@example.com"],
      subject: "สวัสดี",
      sentAt: Date.UTC(2026, 9, 12, 10),
      from: [{ name: "Bob", email: "bob@example.com" }],
      to: [{ name: null, email: "ana@example.com" }],
      cc: [],
    });
  });
});
