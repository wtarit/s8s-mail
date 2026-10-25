import { env } from "cloudflare:workers";
import { describe, expect, it, vi } from "vitest";
import { serveAssetMiss } from "../src/assets";
import { BASE, request } from "./helpers";

vi.mock("../src/send", () => ({ sendSystemMail: vi.fn(async () => {}) }));

/** A static-assets stand-in that knows `files` and answers 404 for anything else. */
function fakeAssets(files: string[]) {
  const fetched: string[] = [];
  const ASSETS = {
    fetch: async (input: RequestInfo | URL) => {
      const { pathname } = new URL(input instanceof Request ? input.url : input);
      fetched.push(pathname);
      return files.includes(pathname)
        ? new Response(`file ${pathname}`, { headers: { "x-file": pathname } })
        : new Response("not found", { status: 404 });
    },
  } as unknown as Fetcher;
  return { assetsEnv: { ...env, ASSETS }, fetched };
}

const FILES = ["/webmail/en/mail/", "/webmail/404.html"];

async function miss(path: string) {
  const { assetsEnv, fetched } = fakeAssets(FILES);
  const res = await serveAssetMiss(new Request(BASE + path), assetsEnv);
  return { status: res.status, body: await res.text(), fetched };
}

describe("asset misses", () => {
  it("serves the webmail config for this deployment", async () => {
    const { assetsEnv } = fakeAssets(FILES);
    const res = await serveAssetMiss(new Request(`${BASE}/webmail/config.json`), assetsEnv);
    expect(res.headers.get("cache-control")).toBe("no-cache");
    expect(await res.json()).toMatchObject({
      jmapServerUrl: BASE,
      oauthClientId: "bulwark-lite",
      oauthResource: `${BASE}/jmap`,
      oauthOnly: true,
      autoSsoEnabled: true,
    });
  });

  it("answers a deep link into a webmail surface with that surface's shell", async () => {
    expect(await miss("/webmail/en/mail/inbox/abc")).toMatchObject({
      status: 200,
      body: "file /webmail/en/mail/",
    });
  });

  it("serves the webmail 404 page for unknown webmail paths and locales", async () => {
    for (const path of ["/webmail/nope.js", "/webmail/xx/mail/inbox"]) {
      expect(await miss(path), path).toMatchObject({ status: 404, body: "file /webmail/404.html" });
    }
  });

  it("answers 404 without an ASSETS binding (API-only deployment)", async () => {
    const apiOnly = { ...env, ASSETS: undefined };
    for (const path of ["/webmail/config.json", "/webmail/en/mail/inbox", "/account"]) {
      const res = await serveAssetMiss(new Request(BASE + path), apiOnly);
      expect(res.status, path).toBe(404);
    }
  });

  it("does not fall back to the SPA for API paths", async () => {
    expect((await request("/api/nope")).status).toBe(404);
    expect((await request("/.well-known/nope")).status).toBe(404);
    // JMAP authenticates before routing
    expect((await request("/jmap/nope")).status).toBe(401);
  });
});
