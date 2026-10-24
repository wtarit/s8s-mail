import { APIError } from "better-auth/api";
import type { AccountChangeStatus } from "./policy";

/** The one error every stale-factor account change answers with; the SPA asks for just `stale`. */
export function reauthRequired(status: Pick<AccountChangeStatus, "stale" | "oneOf">): never {
  throw new APIError("FORBIDDEN", {
    code: "REAUTHENTICATION_REQUIRED",
    message: "Verify your password or passkey again to continue.",
    stale: status.stale,
    oneOf: status.oneOf,
  });
}

export function accountChangeNotAllowed(): never {
  throw APIError.from("FORBIDDEN", {
    code: "ACCOUNT_CHANGE_NOT_ALLOWED",
    message: "This session cannot change account security settings.",
  });
}

export function enrollmentSessionOnly(): never {
  throw APIError.from("FORBIDDEN", {
    code: "ENROLLMENT_SESSION_ONLY",
    message: "This session can only be used to set up the first sign-in method.",
  });
}

export function lastFactor(): never {
  throw APIError.from("CONFLICT", {
    code: "LAST_FACTOR",
    message: "You cannot remove your only sign-in method.",
  });
}

export function currentPasswordRequired(): never {
  throw APIError.from("FORBIDDEN", {
    code: "CURRENT_PASSWORD_REQUIRED",
    message: "Enter your current password to change it.",
  });
}

export function inviteUnavailable(reason: "used" | "expired" | "missing" | "disabled"): never {
  if (reason === "used") {
    throw APIError.from("CONFLICT", {
      code: "INVITE_USED",
      message: "This invite has already been used.",
    });
  }
  throw APIError.from("GONE", {
    code: "INVITE_UNAVAILABLE",
    message:
      reason === "expired"
        ? "This invite has expired. Ask an administrator for a new one."
        : reason === "disabled"
          ? "This account is disabled."
          : "This invite is no longer valid.",
  });
}
