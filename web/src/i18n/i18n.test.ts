import { describe, expect, it } from "vitest";
import { t } from "./index";

describe("t", () => {
  it("returns the catalog message", () => {
    expect(t("login.title")).toBe("Sign in");
  });

  it("interpolates params and leaves unknown placeholders", () => {
    expect(t("brand.logoAlt", { appName: "Acme" })).toBe("Acme logo");
    expect(t("brand.logoAlt")).toBe("{appName} logo");
  });
});
