import type { ApiError } from "@s8s/shared";
import type { Context } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { errorFields } from "../log";

/** Thrown by route code; `onError` turns it into an `apiError` JSON body. */
export class ApiHttpError extends Error {
  constructor(
    readonly status: ContentfulStatusCode,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "ApiHttpError";
  }
}

export function errorBody(code: string, message: string): ApiError {
  return { error: { code, message } };
}

export function respondError(c: Context, err: unknown): Response {
  if (err instanceof ApiHttpError) return c.json(errorBody(err.code, err.message), err.status);
  // Better Auth's APIError (thrown by auth.api.* calls) carries status + body.
  if (isAuthApiError(err)) {
    const status = (
      err.statusCode >= 400 && err.statusCode < 600 ? err.statusCode : 400
    ) as ContentfulStatusCode;
    const code = String(err.body?.code ?? err.body?.error ?? "auth_error").toLowerCase();
    const message = String(err.body?.message ?? err.body?.error_description ?? err.message);
    return c.json(errorBody(code, message), status);
  }
  console.error({
    msg: "unhandled error",
    method: c.req.method,
    path: c.req.path,
    ...errorFields(err, { stack: true }),
  });
  return c.json(errorBody("internal_error", "Internal server error"), 500);
}

interface AuthApiErrorLike {
  statusCode: number;
  body?: { code?: unknown; error?: unknown; message?: unknown; error_description?: unknown };
  message: string;
}

function isAuthApiError(err: unknown): err is AuthApiErrorLike {
  return (
    err instanceof Error &&
    err.name === "APIError" &&
    typeof (err as { statusCode?: unknown }).statusCode === "number"
  );
}
