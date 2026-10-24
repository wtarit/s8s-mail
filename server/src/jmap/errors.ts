/** JMAP error values. Method errors become `["error", {...}, callId]`; request errors are HTTP 400s. */
import type { SetError } from "./types";

/** A method-level error (RFC 8620 §3.6.2). Thrown by handlers; the dispatcher renders it. */
export class MethodError extends Error {
  constructor(
    readonly type: string,
    description?: string,
    readonly extra: Record<string, unknown> = {},
  ) {
    super(description ?? type);
    this.name = "MethodError";
    this.description = description;
  }
  readonly description: string | undefined;

  toJSON(): Record<string, unknown> {
    return {
      type: this.type,
      ...(this.description ? { description: this.description } : {}),
      ...this.extra,
    };
  }
}

export const invalidArguments = (description: string, extra?: Record<string, unknown>) =>
  new MethodError("invalidArguments", description, extra);

/** A request-level problem (RFC 8620 §3.6.1): HTTP 400 with a problem-details body. */
export class RequestError extends Error {
  constructor(
    readonly type: string,
    readonly status: number,
    detail: string,
    readonly extra: Record<string, unknown> = {},
  ) {
    super(detail);
    this.name = "RequestError";
  }

  toResponse(): Response {
    return new Response(
      JSON.stringify({ type: this.type, status: this.status, detail: this.message, ...this.extra }),
      { status: this.status, headers: { "Content-Type": "application/problem+json" } },
    );
  }
}

export const REQUEST_ERRORS = {
  notJSON: "urn:ietf:params:jmap:error:notJSON",
  notRequest: "urn:ietf:params:jmap:error:notRequest",
  unknownCapability: "urn:ietf:params:jmap:error:unknownCapability",
  limit: "urn:ietf:params:jmap:error:limit",
} as const;

export const setError = (
  type: string,
  description?: string,
  properties?: string[],
  extra?: Record<string, unknown>,
): SetError => ({
  type,
  ...(description ? { description } : {}),
  ...(properties ? { properties } : {}),
  ...extra,
});
