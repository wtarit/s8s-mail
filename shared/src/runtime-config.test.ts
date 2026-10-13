import { describe, expect, it } from "vitest";
import { DEFAULT_RUNTIME_CONFIG, parseRuntimeConfig } from "./runtime-config";

describe("parseRuntimeConfig", () => {
  it("applies defaults to an empty object", () => {
    expect(parseRuntimeConfig({})).toEqual({ apiBaseUrl: "", appName: "S8S Mail" });
  });

  it("keeps provided values", () => {
    const cfg = parseRuntimeConfig({
      apiBaseUrl: "https://mail.example.com",
      issuer: "https://mail.example.com",
      appName: "Acme Mail",
      logoLightUrl: "/l.svg",
      logoDarkUrl: "/d.svg",
    });
    expect(cfg.appName).toBe("Acme Mail");
    expect(cfg.apiBaseUrl).toBe("https://mail.example.com");
    expect(cfg.logoDarkUrl).toBe("/d.svg");
  });

  it("falls back to defaults on invalid input", () => {
    expect(parseRuntimeConfig(null)).toEqual(DEFAULT_RUNTIME_CONFIG);
    expect(parseRuntimeConfig({ appName: 42 })).toEqual(DEFAULT_RUNTIME_CONFIG);
    expect(parseRuntimeConfig({ appName: "" })).toEqual(DEFAULT_RUNTIME_CONFIG);
  });
});
