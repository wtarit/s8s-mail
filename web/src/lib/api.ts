import { apiError } from "#shared";
import type { z } from "zod";
import { getApiBase } from "@/lib/api-base";
import { t } from "@/i18n";

/** Error from one of our own `/api/*` endpoints (not Better Auth). */
export class ApiRequestError extends Error {
  readonly status: number;
  readonly code: string;
  /** Extra fields of the error body (e.g. `stale` and `oneOf` of REAUTHENTICATION_REQUIRED). */
  readonly details: Readonly<Record<string, unknown>>;

  constructor(
    status: number,
    code: string,
    message: string,
    details: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = "ApiRequestError";
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export interface ApiInit {
  method?: "GET" | "POST" | "PATCH" | "PUT" | "DELETE";
  body?: unknown;
  signal?: AbortSignal;
}

async function request(path: string, init: ApiInit): Promise<Response> {
  let response: Response;
  try {
    response = await fetch(`${getApiBase()}${path}`, {
      method: init.method ?? "GET",
      credentials: "include",
      headers: {
        accept: "application/json",
        ...(init.body !== undefined ? { "content-type": "application/json" } : {}),
      },
      body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
      signal: init.signal,
    });
  } catch {
    throw new ApiRequestError(0, "network_error", t("error.network"));
  }
  if (!response.ok) {
    let code = "http_error";
    let message = t("error.generic");
    try {
      const parsed = apiError.safeParse(await response.json());
      if (parsed.success) {
        code = parsed.data.error.code;
        message = parsed.data.error.message;
      }
    } catch {
      // non-JSON error body: keep the generic message
    }
    throw new ApiRequestError(response.status, code, message);
  }
  return response;
}

/** Call one of our endpoints and validate the JSON body with a `#shared` schema. */
export async function api<S extends z.ZodType>(
  path: string,
  schema: S,
  init: ApiInit = {},
): Promise<z.output<S>> {
  const response = await request(path, init);
  let json: unknown;
  try {
    json = await response.json();
  } catch {
    throw new ApiRequestError(response.status, "invalid_response", t("error.invalidResponse"));
  }
  const parsed = schema.safeParse(json);
  if (!parsed.success) {
    throw new ApiRequestError(response.status, "invalid_response", t("error.invalidResponse"));
  }
  return parsed.data;
}

/** Call an endpoint whose response body the SPA does not use. */
export async function apiVoid(path: string, init: ApiInit = {}): Promise<void> {
  await request(path, init);
}

/** Message to show for any thrown value. */
export function errorMessage(error: unknown): string {
  if (error instanceof ApiRequestError) return error.message;
  return t("error.generic");
}

interface AuthResult<T> {
  data: T | null;
  error: ({ message?: string; code?: string; status?: number } & Record<string, unknown>) | null;
}

/** Unwrap a Better Auth client `{data, error}` result, throwing an ApiRequestError on failure. */
export async function unwrapAuth<T>(result: Promise<AuthResult<T>>): Promise<T> {
  let r: AuthResult<T>;
  try {
    r = await result;
  } catch {
    throw new ApiRequestError(0, "network_error", t("error.network"));
  }
  if (r.error || r.data === null) {
    throw new ApiRequestError(
      r.error?.status ?? 0,
      r.error?.code ?? "auth_error",
      r.error?.message?.trim() || t("error.generic"),
      r.error ?? {},
    );
  }
  return r.data;
}
