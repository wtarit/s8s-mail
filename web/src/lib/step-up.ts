import type { FactorName, MeResponse } from "#shared";
import { ApiRequestError } from "@/lib/api";

/** What an account change still needs from this session. */
export interface StepUpRequirement {
  stale: FactorName[];
  /** Verifying any ONE of `stale` is enough. */
  oneOf: boolean;
}

/** The user closed the step-up prompt without finishing it. Callers stay quiet about it. */
export class StepUpCancelledError extends Error {
  constructor() {
    super("STEP_UP_CANCELLED");
    this.name = "StepUpCancelledError";
  }
}

export function isStepUpCancelled(error: unknown): boolean {
  return error instanceof StepUpCancelledError;
}

const FACTORS: readonly string[] = ["password", "passkey"];

/** The requirement carried by a 403 REAUTHENTICATION_REQUIRED, or null for any other error. */
export function reauthRequirement(error: unknown): StepUpRequirement | null {
  if (!(error instanceof ApiRequestError) || error.code !== "REAUTHENTICATION_REQUIRED") {
    return null;
  }
  const { stale, oneOf } = error.details;
  const factors = Array.isArray(stale)
    ? stale.filter((f): f is FactorName => typeof f === "string" && FACTORS.includes(f))
    : [];
  return { stale: factors, oneOf: oneOf === true };
}

/** What `/api/me` says the session must still verify (empty when nothing is stale). */
export function requirementFromMe(me: MeResponse): StepUpRequirement {
  const { stale, oneOf } = me.user.accountChange;
  return { stale, oneOf };
}

/**
 * The factors the prompt still has to ask for. `provides` lists factors the action itself proves
 * (the password form sends the current password), so they never need a separate prompt.
 */
export function pendingFactors(
  requirement: StepUpRequirement,
  provides: readonly FactorName[] = [],
): FactorName[] {
  const { stale, oneOf } = requirement;
  if (oneOf) return stale.some((f) => provides.includes(f)) ? [] : stale;
  return stale.filter((f) => !provides.includes(f));
}
