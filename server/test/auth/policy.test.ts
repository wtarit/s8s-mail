import { describe, expect, it } from "vitest";
import {
  accountChangeStatus,
  FRESH_WINDOW_MS,
  signInSatisfied,
  type UserFactors,
} from "../../src/auth/factors/policy";

const NOW = 1_000_000_000_000;
const ago = (ms: number) => NOW - ms;
const password: UserFactors = { password: true, passkeys: 0 };
const passkey: UserFactors = { password: false, passkeys: 2 };
const both: UserFactors = { password: true, passkeys: 1 };

describe("signInSatisfied", () => {
  it.each([
    ["password-only: password", password, { password: true }, true],
    ["password-only: recovery", password, { recovery: true }, true],
    ["passkey-only: passkey", passkey, { passkey: true }, true],
    ["passkey-only: recovery", passkey, { recovery: true }, true],
    ["2FA: passkey alone", both, { passkey: true }, true],
    ["2FA: password alone", both, { password: true }, false],
    ["2FA: recovery alone", both, { recovery: true }, false],
    ["2FA: password + recovery", both, { password: true, recovery: true }, true],
    ["2FA: passkey + recovery", both, { passkey: true, recovery: true }, true],
    ["no factors: recovery", { password: false, passkeys: 0 }, { recovery: true }, false],
    ["nothing verified", both, {}, false],
    ["passkey claimed by a user without passkeys", password, { passkey: true }, false],
  ])("%s", (_name, have, verified, expected) => {
    expect(signInSatisfied(have, verified)).toBe(expected);
  });
});

describe("accountChangeStatus", () => {
  it("allows when every factor the user has is within the window (inclusive)", () => {
    const stamps = { password: ago(FRESH_WINDOW_MS), passkey: ago(1000) };
    expect(accountChangeStatus(both, stamps, NOW)).toMatchObject({ allowed: true, stale: [] });
    expect(
      accountChangeStatus(both, { ...stamps, password: ago(FRESH_WINDOW_MS + 1) }, NOW),
    ).toMatchObject({ allowed: false, stale: ["password"] });
  });

  it("only counts factors the user has, and an unverified one is stale", () => {
    expect(accountChangeStatus(password, { passkey: ago(0) }, NOW).stale).toEqual(["password"]);
    expect(accountChangeStatus(passkey, {}, NOW).stale).toEqual(["passkey"]);
    expect(accountChangeStatus({ password: false, passkeys: 0 }, {}, NOW).allowed).toBe(true);
  });

  it("a stamp from the future is not fresh", () => {
    expect(accountChangeStatus(password, { password: NOW + 5000 }, NOW).allowed).toBe(false);
  });

  it("recovery stands in for exactly one missing factor", () => {
    const recovery = ago(1000);
    expect(accountChangeStatus(password, { recovery }, NOW).allowed).toBe(true);
    expect(accountChangeStatus(both, { recovery, passkey: ago(10) }, NOW).allowed).toBe(true);
    const neither = accountChangeStatus(both, { recovery }, NOW);
    expect(neither).toMatchObject({ allowed: false, stale: ["password", "passkey"], oneOf: true });
    // An old recovery link covers nothing.
    expect(accountChangeStatus(password, { recovery: ago(FRESH_WINDOW_MS + 1) }, NOW).allowed).toBe(
      false,
    );
  });

  it("the current-password proof counts as the password and is required unless recovering", () => {
    expect(accountChangeStatus(both, { passkey: ago(10) }, NOW, ["password"]).allowed).toBe(true);
    expect(accountChangeStatus(both, {}, NOW, ["password"]).stale).toEqual(["passkey"]);
    expect(accountChangeStatus(both, {}, NOW).currentPasswordRequired).toBe(true);
    expect(accountChangeStatus(passkey, {}, NOW).currentPasswordRequired).toBe(false);
    expect(accountChangeStatus(password, { recovery: ago(10) }, NOW).currentPasswordRequired).toBe(
      false,
    );
  });
});
