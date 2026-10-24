import type * as Opaque from "@serenity-kit/opaque";

export type Command =
  | { type: "login-start"; password: string }
  | { type: "password-start"; newPassword: string; currentPassword?: string }
  | { type: "finish"; loginResponse?: string; registrationResponse?: string };
export interface ProtocolResult {
  startLoginRequest?: string;
  registrationRequest?: string;
  finishLoginRequest?: string;
  registrationRecord?: string;
}
export type Failure = "OPAQUE_FAILED" | "INVALID_EMAIL_OR_PASSWORD";
export class ProtocolError extends Error {
  constructor(readonly code: Failure) {
    super(code);
  }
}

/** One handshake per dedicated worker. Secret state never crosses back to the page. */
export function createProtocol(opaque: typeof Opaque) {
  let pending:
    | {
        password: string;
        loginState?: string;
        newPassword?: string;
        registrationState?: string;
      }
    | undefined;
  return (command: Command): ProtocolResult => {
    if (command.type !== "finish") {
      if (pending) throw new ProtocolError("OPAQUE_FAILED");
      if (command.type === "login-start") {
        const start = opaque.client.startLogin({ password: command.password });
        pending = { password: command.password, loginState: start.clientLoginState };
        return { startLoginRequest: start.startLoginRequest };
      }
      const registration = opaque.client.startRegistration({ password: command.newPassword });
      const login = command.currentPassword
        ? opaque.client.startLogin({ password: command.currentPassword })
        : undefined;
      pending = {
        password: command.currentPassword ?? "",
        newPassword: command.newPassword,
        registrationState: registration.clientRegistrationState,
        loginState: login?.clientLoginState,
      };
      return {
        registrationRequest: registration.registrationRequest,
        ...(login ? { startLoginRequest: login.startLoginRequest } : {}),
      };
    }
    const state = pending;
    pending = undefined;
    if (!state) throw new ProtocolError("OPAQUE_FAILED");
    const result: ProtocolResult = {};
    if (state.loginState) {
      if (!command.loginResponse) throw new ProtocolError("OPAQUE_FAILED");
      const login = opaque.client.finishLogin({
        password: state.password,
        clientLoginState: state.loginState,
        loginResponse: command.loginResponse,
      });
      if (!login) throw new ProtocolError("INVALID_EMAIL_OR_PASSWORD");
      result.finishLoginRequest = login.finishLoginRequest;
    }
    if (state.registrationState && state.newPassword !== undefined) {
      if (!command.registrationResponse) throw new ProtocolError("OPAQUE_FAILED");
      const registration = opaque.client.finishRegistration({
        password: state.newPassword,
        clientRegistrationState: state.registrationState,
        registrationResponse: command.registrationResponse,
      });
      result.registrationRecord = registration.registrationRecord;
    }
    return result;
  };
}
