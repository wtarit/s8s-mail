import { env, exports } from "cloudflare:workers";

export const BASE = "http://localhost:8787";
export const BOOTSTRAP_TOKEN = "test-bootstrap-token";

const TABLES = [
  "pending_sign_in",
  "opaque_challenge",
  "opaque_credential",
  "oauth_access_token",
  "oauth_refresh_token",
  "oauth_consent",
  "oauth_client_resource",
  "oauth_client",
  "oauth_resource",
  "oauth_client_assertion",
  "invite",
  "apikey",
  "passkey",
  "session",
  "account",
  "verification",
  "address",
  "mail_account",
  "domain",
  "user",
  "jwks",
  "rate_limit",
];

/** Empties every table (tests share one D1 per file run). */
export async function resetDb(): Promise<void> {
  for (const t of TABLES) await env.DB.prepare(`DELETE FROM ${t}`).run();
}

export interface Reply<T = unknown> {
  status: number;
  headers: Headers;
  body: T;
}

/** Loosely typed JSON for assertions on response bodies. */
// oxlint-disable-next-line typescript/no-explicit-any
export type Json = any;

export async function request<T = Json>(
  path: string,
  init: {
    method?: string;
    json?: unknown;
    cookie?: string;
    headers?: Record<string, string>;
    origin?: string | null;
  } = {},
): Promise<Reply<T>> {
  const headers = new Headers(init.headers);
  if (init.json !== undefined) headers.set("content-type", "application/json");
  if (init.cookie) headers.set("cookie", init.cookie);
  const method = init.method ?? (init.json !== undefined ? "POST" : "GET");
  if (init.origin !== null && method !== "GET" && !headers.has("origin")) {
    headers.set("origin", init.origin ?? BASE);
  }
  const res = await exports.default.fetch(
    new Request(BASE + path, {
      method,
      headers,
      body: init.json !== undefined ? JSON.stringify(init.json) : undefined,
      redirect: "manual",
    }),
  );
  const text = await res.text();
  let body: unknown = text;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    // leave as text
  }
  return { status: res.status, headers: res.headers, body: body as T };
}

/** "name=value; name2=value2" from a response's Set-Cookie headers (last value per name; cleared cookies dropped). */
export function cookieFrom(headers: Headers): string {
  const cookies = new Map<string, string>();
  for (const header of headers.getSetCookie()) {
    const [pair = ""] = header.split(";");
    const eq = pair.indexOf("=");
    const name = pair.slice(0, eq);
    if (pair.slice(eq + 1)) cookies.set(name, pair);
    else cookies.delete(name);
  }
  return [...cookies.values()].join("; ");
}

export function tokenFromInviteUrl(url: string): string {
  return url.split("/invite/")[1]!;
}

export interface Session {
  cookie: string;
  userId: string;
}
