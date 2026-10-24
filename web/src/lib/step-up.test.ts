import { describe, expect, it } from "vitest";
import { ApiRequestError } from "@/lib/api";
import { ME_USER } from "@/test/helpers";
import { pendingFactors, reauthRequirement, requirementFromMe } from "./step-up";

describe("pendingFactors", () => {
  it("asks for every stale factor unless the action proves it", () => {
    const both = { stale: ["password", "passkey"] as const, oneOf: false };
    expect(pendingFactors({ ...both, stale: [...both.stale] })).toEqual(["password", "passkey"]);
    expect(pendingFactors({ ...both, stale: [...both.stale] }, ["password"])).toEqual(["passkey"]);
  });
  it("needs nothing when verifying one is enough and the action proves one", () => {
    const either = { stale: ["password" as const, "passkey" as const], oneOf: true };
    expect(pendingFactors(either)).toEqual(["password", "passkey"]);
    expect(pendingFactors(either, ["password"])).toEqual([]);
  });
  it("needs nothing when nothing is stale (also an impersonated session)", () => {
    expect(pendingFactors({ stale: [], oneOf: false })).toEqual([]);
  });
});

describe("reauthRequirement", () => {
  it("reads stale and oneOf from the 403 body", () => {
    const error = new ApiRequestError(403, "REAUTHENTICATION_REQUIRED", "x", {
      stale: ["passkey", "bogus"],
      oneOf: true,
    });
    expect(reauthRequirement(error)).toEqual({ stale: ["passkey"], oneOf: true });
  });
  it("ignores every other error", () => {
    expect(reauthRequirement(new ApiRequestError(403, "LAST_FACTOR", "x"))).toBeNull();
    expect(reauthRequirement(new Error("x"))).toBeNull();
  });
});

describe("requirementFromMe", () => {
  it("takes the stale factors from /api/me", () => {
    const me = structuredClone(ME_USER) as unknown as Parameters<typeof requirementFromMe>[0];
    me.user.accountChange = {
      allowed: false,
      stale: ["passkey"],
      oneOf: false,
      currentPasswordRequired: true,
    };
    expect(requirementFromMe(me)).toEqual({ stale: ["passkey"], oneOf: false });
  });
});
