import { env, exports } from "cloudflare:workers";
import { Hono } from "hono";
import { expect } from "vitest";
import { jmapAuth, resetJmapAuthCaches } from "../../src/auth/jmap-auth";
import type { AppEnv } from "../../src/auth/types";
import { BASE, request, resetDb as resetTables, type Session, type Json } from "./index";

// What the JMAP module does: put jmapAuth in front of its routes and read c.var.principal.
export const jmap = new Hono<AppEnv>();
jmap.use("*", jmapAuth);
jmap.get("/session", (c) => c.json(c.var.principal));
export const callJmap = (authorization?: string, bindings: Env = env) =>
  jmap.fetch(
    new Request("http://localhost:8787/session", {
      headers: authorization ? { authorization } : {},
    }),
    bindings,
  );

/** Tables are wiped, so the per-isolate key/client caches of jmapAuth must go too. */
export async function resetDb(): Promise<void> {
  await resetTables();
  resetJmapAuthCaches();
}

/** A copy of the bindings whose D1 records every SQL string prepared through it. */
export function recordingEnv(): { bindings: Env; sql: string[] } {
  const sql: string[] = [];
  const DB = new Proxy(env.DB, {
    get(target, prop) {
      const value = Reflect.get(target, prop, target);
      if (prop === "prepare") {
        return (query: string) => {
          sql.push(query);
          return target.prepare(query);
        };
      }
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  return { bindings: { ...env, DB } as Env, sql };
}

/** Tables a recorded SQL string reads or writes (`from "x"`, `into "x"`, `update "x"`). */
export const tablesOf = (sql: string[]) =>
  [
    ...new Set(
      sql
        .flatMap((q) => [...q.matchAll(/(?:from|into|update|join)\s+"?(\w+)"?/gi)])
        .map((m) => m[1]!),
    ),
  ].toSorted();

export const decodePart = (jwt: string, index: 0 | 1): Json =>
  JSON.parse(atob(jwt.split(".")[index]!.replaceAll("-", "+").replaceAll("_", "/")));

export const bearer = (t: string) => `Bearer ${t}`;
export const sidOf = (t: string) => decodePart(t, 1).sid as string;

export const JMAP_RESOURCE = `${BASE}/jmap`;

export const basic = (user: string, pass: string) => `Basic ${btoa(`${user}:${pass}`)}`;

export async function createAppPassword(session: Session): Promise<string> {
  const res = await request<{ key: string }>("/api/auth/api-key/create", {
    method: "POST",
    cookie: session.cookie,
    json: { name: "Thunderbird" },
  });
  expect(res.status).toBe(200);
  return res.body.key;
}

export function b64url(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");
}

export const REDIRECT = `${BASE}/webmail/oauth/callback`;

/** Starts an authorization-code + PKCE flow against the Bulwark client; returns the redirect. */
export async function authorize(session: Session, resource?: string) {
  const verifier = b64url(crypto.getRandomValues(new Uint8Array(32)));
  const challenge = b64url(
    new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))),
  );
  const q = new URLSearchParams({
    response_type: "code",
    client_id: "bulwark-lite",
    redirect_uri: REDIRECT,
    scope: "openid profile email offline_access",
    state: "xyz",
    code_challenge: challenge,
    code_challenge_method: "S256",
    ...(resource ? { resource } : {}),
  });
  const authz = await request(`/api/auth/oauth2/authorize?${q}`, { cookie: session.cookie });
  expect(authz.status).toBe(302);
  return { location: new URL(authz.headers.get("location")!, BASE), verifier };
}

/** Authorization-code + PKCE flow against the Bulwark client; returns the token response. */
export async function oauthTokens(session: Session, resource?: string) {
  const { location, verifier } = await authorize(session, resource);
  expect(location.origin + location.pathname).toBe(REDIRECT);
  expect(location.searchParams.get("state")).toBe("xyz");
  const code = location.searchParams.get("code")!;
  expect(code).toBeTruthy();

  return fetchToken(code, verifier, REDIRECT, resource);
}

export async function fetchToken(
  code: string,
  verifier: string,
  redirect: string,
  resource?: string,
) {
  const res = await exports.default.fetch(
    new Request("http://localhost:8787/api/auth/oauth2/token", {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        origin: BASE,
      },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code,
        redirect_uri: redirect,
        client_id: "bulwark-lite",
        code_verifier: verifier,
        ...(resource ? { resource } : {}),
      }),
    }),
  );
  return { status: res.status, body: (await res.json()) as Json, headers: res.headers };
}

/** Refresh-token grant, deliberately without a `resource` parameter. */
export async function refreshTokens(refreshToken: string) {
  const res = await exports.default.fetch(
    new Request(`${BASE}/api/auth/oauth2/token`, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        origin: BASE,
      },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: refreshToken,
        client_id: "bulwark-lite",
      }),
    }),
  );
  return { status: res.status, body: (await res.json()) as Json };
}
