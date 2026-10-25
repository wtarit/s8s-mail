import { jmapResourceIdentifier, publicOrigin } from "./auth/config";

// Static assets run with `not_found_handling: "none"`: files (the SPA and the webmail, which
// `pnpm build` puts under web/dist/webmail/) are served without the Worker, and only misses
// reach it. `env.ASSETS.fetch` then answers 404 for a missing file instead of the SPA's index.
// The frontend is optional: without an `assets` block (an API-only deployment) there is no
// ASSETS binding, and every miss is a plain 404.

/** Surfaces of the webmail (Bulwark Lite, built for /webmail) whose shell serves deep links. */
const DEEP_LINK = /^\/webmail\/([^/]+)\/(mail|calendar|contacts|files|settings)\//;

type AssetsEnv = Pick<Env, "APP_NAME" | "PUBLIC_URL" | "BULWARK_CLIENT_ID"> & {
  ASSETS?: Fetcher;
};

/** `/webmail/config.json`: the Lite runtime config of this deployment. */
export function webmailConfig(env: Omit<AssetsEnv, "ASSETS">) {
  return {
    appName: env.APP_NAME || "S8S Mail",
    jmapServerUrl: publicOrigin(env),
    oauthClientId: env.BULWARK_CLIENT_ID,
    // JWT access tokens are only issued for this resource, and JMAP accepts no other Bearer.
    oauthResource: jmapResourceIdentifier(env),
    // Bulwark's password form would send the account password as Basic auth, but JMAP takes
    // only app passwords there. Same origin as our sign-in, so SSO needs no click.
    oauthOnly: true,
    autoSsoEnabled: true,
    // AGPL: the webmail's About page links to the source of what we serve.
    sourceCodeUrl: "https://github.com/wtarit/s8s-mail-webmail",
  };
}

/**
 * A GET that matched no static asset: a deep link into a webmail surface gets that surface's
 * shell, other /webmail paths the webmail's 404 page, and anything else the SPA's index.html
 * (a client-side route).
 */
export async function serveAssetMiss(req: Request, env: AssetsEnv): Promise<Response> {
  const assets = env.ASSETS;
  if (!assets) return new Response("Not Found", { status: 404 });
  const url = new URL(req.url);
  if (url.pathname === "/webmail/config.json") {
    return Response.json(webmailConfig(env), { headers: { "cache-control": "no-cache" } });
  }
  if (!url.pathname.startsWith("/webmail/")) return assets.fetch(new URL("/", url));
  const deepLink = DEEP_LINK.exec(url.pathname);
  if (deepLink) {
    const shell = await assets.fetch(new URL(`/webmail/${deepLink[1]}/${deepLink[2]}/`, url));
    if (shell.ok) return shell;
  }
  const page = await assets.fetch(new URL("/webmail/404.html", url));
  return new Response(page.body, { status: 404, headers: page.headers });
}
