import { describe, expect, it } from "vitest";
import { MimeBuildError, buildMime, envelopeFromEmail, removeBccHeader } from "../../src/mime";
import { baseEmail, baseOptions, dec, enc, parse } from "../helpers/mime";

describe("removeBccHeader", () => {
  it("removes a folded Bcc header and nothing else", () => {
    const msg =
      "From: a@example.com\r\nBcc: Hidden One <h1@example.com>,\r\n  h2@example.com,\r\n\th3@example.com\r\nSubject: Bcc: not a header\r\n\r\nBcc: body line stays\r\n";
    const out = dec.decode(removeBccHeader(enc.encode(msg)));
    expect(out).toBe(
      "From: a@example.com\r\nSubject: Bcc: not a header\r\n\r\nBcc: body line stays\r\n",
    );
  });

  it("handles case-insensitive names, the first and last header, and bare LF", () => {
    expect(
      dec.decode(
        removeBccHeader(enc.encode("BCC: x@example.com\r\nTo: y@example.com\r\n\r\nbody")),
      ),
    ).toBe("To: y@example.com\r\n\r\nbody");
    expect(
      dec.decode(removeBccHeader(enc.encode("To: y@example.com\nbcc: x@example.com\n\nbody"))),
    ).toBe("To: y@example.com\n\nbody");
    expect(
      dec.decode(removeBccHeader(enc.encode("To: y@example.com\r\nBcc: x@example.com\r\n\r\n"))),
    ).toBe("To: y@example.com\r\n\r\n");
  });

  it("returns the input when there is no Bcc header", () => {
    const raw = enc.encode("To: y@example.com\r\n\r\nBcc: only in body\r\n");
    expect(removeBccHeader(raw)).toEqual(raw);
  });

  it("strips Bcc from a built message but keeps it parseable", async () => {
    const bcc = Array.from({ length: 12 }, (_, i) => ({
      name: `Hidden ${i}`,
      email: `h${i}@example.com`,
    }));
    const { raw } = await buildMime({ ...baseEmail, bcc }, { ...baseOptions, includeBcc: true });
    expect((await parse(raw)).bcc).toHaveLength(12);
    const stripped = removeBccHeader(raw);
    expect(stripped.length).toBeLessThan(raw.length);
    expect(dec.decode(stripped)).not.toMatch(/^Bcc:/im);
    const m = await parse(stripped);
    expect(m.bcc).toBeUndefined();
    expect(m.subject).toBe("Hello");
    expect(m.text?.trim()).toBe("Hi Bob");
  });
});

describe("envelopeFromEmail", () => {
  it("collects To+Cc+Bcc deduplicated, mailFrom from From", () => {
    expect(
      envelopeFromEmail({
        from: [{ email: "alice@example.com" }],
        to: [{ email: "bob@example.com" }, { email: "Carol@example.com" }],
        cc: [{ email: "carol@EXAMPLE.com" }, { email: "dave@example.com" }],
        bcc: [{ email: "bob@example.com" }, { email: "erin@example.com" }],
      }),
    ).toEqual({
      mailFrom: "alice@example.com",
      rcptTo: ["bob@example.com", "Carol@example.com", "dave@example.com", "erin@example.com"],
    });
  });

  it("prefers Sender and throws without a From", () => {
    expect(
      envelopeFromEmail({
        from: [{ email: "alice@example.com" }],
        sender: [{ email: "secretary@example.com" }],
      }).mailFrom,
    ).toBe("secretary@example.com");
    expect(() => envelopeFromEmail({ from: [] })).toThrow(MimeBuildError);
  });
});
