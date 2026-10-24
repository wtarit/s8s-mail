import { beforeAll, describe, expect, it } from "vitest";
import * as opaque from "@serenity-kit/opaque";
import { createProtocol } from "./protocol";

beforeAll(() => opaque.ready);
const password = "a-strong-example-password";
function register() {
  const setup = opaque.server.createSetup();
  const protocol = createProtocol(opaque);
  const start = protocol({ type: "password-start", newPassword: password });
  const response = opaque.server.createRegistrationResponse({
    serverSetup: setup,
    userIdentifier: "u1",
    registrationRequest: start.registrationRequest!,
  });
  const finished = protocol({
    type: "finish",
    ...response,
  });
  return { setup, registrationRecord: finished.registrationRecord! };
}

describe("OPAQUE worker protocol", () => {
  it("registers and proves a password without exposing password/state/keys to the page", () => {
    const { setup, registrationRecord } = register();
    const protocol = createProtocol(opaque);
    const start = protocol({ type: "login-start", password });
    expect(Object.keys(start)).toEqual(["startLoginRequest"]);
    const challenge = opaque.server.startLogin({
      serverSetup: setup,
      userIdentifier: "u1",
      registrationRecord,
      startLoginRequest: start.startLoginRequest!,
    });
    const finish = protocol({
      type: "finish",
      loginResponse: challenge.loginResponse,
    });
    expect(Object.keys(finish)).toEqual(["finishLoginRequest"]);
    expect(
      opaque.server.finishLogin({
        serverLoginState: challenge.serverLoginState,
        finishLoginRequest: finish.finishLoginRequest!,
      }).sessionKey,
    ).toBeTruthy();
    expect(() =>
      protocol({
        type: "finish",
        loginResponse: challenge.loginResponse,
      }),
    ).toThrow("OPAQUE_FAILED");
  });

  it("uses the current credential proof and a new registration during password changes", () => {
    const { setup, registrationRecord } = register();
    const protocol = createProtocol(opaque);
    const start = protocol({
      type: "password-start",
      currentPassword: password,
      newPassword: "a-different-strong-password",
    });
    const registration = opaque.server.createRegistrationResponse({
      serverSetup: setup,
      userIdentifier: "u1",
      registrationRequest: start.registrationRequest!,
    });
    const login = opaque.server.startLogin({
      serverSetup: setup,
      userIdentifier: "u1",
      registrationRecord,
      startLoginRequest: start.startLoginRequest!,
    });
    const finish = protocol({
      type: "finish",
      ...registration,
      loginResponse: login.loginResponse,
    });
    expect(finish.registrationRecord).toBeTruthy();
    expect(
      opaque.server.finishLogin({
        serverLoginState: login.serverLoginState,
        finishLoginRequest: finish.finishLoginRequest!,
      }).sessionKey,
    ).toBeTruthy();
  });

  it("rejects a wrong current password before returning a replacement record", () => {
    const { setup, registrationRecord } = register();
    const protocol = createProtocol(opaque);
    const start = protocol({
      type: "password-start",
      currentPassword: "wrong-password",
      newPassword: password,
    });
    const registration = opaque.server.createRegistrationResponse({
      serverSetup: setup,
      userIdentifier: "u1",
      registrationRequest: start.registrationRequest!,
    });
    const login = opaque.server.startLogin({
      serverSetup: setup,
      userIdentifier: "u1",
      registrationRecord,
      startLoginRequest: start.startLoginRequest!,
    });
    expect(() =>
      protocol({
        type: "finish",
        ...registration,
        loginResponse: login.loginResponse,
      }),
    ).toThrow("INVALID_EMAIL_OR_PASSWORD");
  });
});
