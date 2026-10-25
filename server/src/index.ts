import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { api } from "./api/routes";
import { serveAssetMiss } from "./assets";
import { authServerMetadata, getAuth, openIdConfig } from "./auth";
import { runWithWaitUntil } from "./auth/request-context";
import type { AppEnv } from "./auth/types";
import { jmapAuth } from "./auth/jmap-auth";
import { jmapApp, wellKnownJmap } from "./jmap";
import { handleEmail } from "./mail/ingest";

export { AccountDO } from "./store/account-do";
export { jmapAuth } from "./auth/jmap-auth";

const app = new Hono<AppEnv>();

// Let Better Auth background work and system-mail sending outlive the response.
app.use("*", async (c, next) => {
  let ctx: { waitUntil(p: Promise<unknown>): void } | undefined;
  try {
    ctx = c.executionCtx;
  } catch {
    // no ExecutionContext (unit tests calling app.fetch directly)
  }
  await runWithWaitUntil((p) => ctx?.waitUntil(p), next);
});

app.get("/api/health", (c) => c.json({ ok: true }));

// OIDC / OAuth discovery at the origin root (the issuer is `${PUBLIC_URL}/api/auth`).
app.get("/.well-known/openid-configuration", (c) => openIdConfig(c.env, c.req.raw));
app.get("/.well-known/oauth-authorization-server", (c) => authServerMetadata(c.env, c.req.raw));
// RFC 8414 path-inserted form for an issuer that has a path.
app.get("/.well-known/oauth-authorization-server/api/auth", (c) =>
  authServerMetadata(c.env, c.req.raw),
);

// Better Auth: sign-in, sessions, passkeys, magic links, API keys, OAuth provider endpoints.
for (const path of ["/api/auth/opaque/*", "/api/auth/step-up/*"]) {
  app.use(path, bodyLimit({ maxSize: 16 * 1024 }));
  app.use(path, async (c, next) => {
    await next();
    c.header("Cache-Control", "no-store");
  });
}
app.on(["GET", "POST"], "/api/auth/*", async (c) => (await getAuth(c.env)).handler(c.req.raw));

// Our own REST API (see shared/src/api.ts).
app.route("/api", api);

// JMAP (RFC 8620/8621): session discovery, API, upload/download, event source.
app.get("/.well-known/jmap", wellKnownJmap);
app.use("/jmap/*", jmapAuth);
app.route("/jmap", jmapApp);

// No static asset at this path: the SPA's client-side routes and the webmail (see ./assets).
app.get("*", (c) =>
  /^\/(api|jmap|\.well-known)(\/|$)/.test(c.req.path)
    ? c.notFound()
    : serveAssetMiss(c.req.raw, c.env),
);

export default {
  fetch: app.fetch,
  email: handleEmail,
} satisfies ExportedHandler<Env>;
