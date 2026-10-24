import { describe, expect, it } from "vitest";

describe("encoders", () => {
  it("base64Lines output is exactly sized and CRLF-terminated for every length", async () => {
    const { base64Lines } = await import("../../src/mime/encode");
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
