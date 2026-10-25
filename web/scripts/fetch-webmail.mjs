import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { unzipSync } from "fflate";

// Puts the webmail (Bulwark Lite from our fork, built for the /webmail base path) into
// dist/webmail/, after `vite build` has emptied dist/. The zip is downloaded from the fork's
// release pinned in webmail.json, verified, and never committed (Bulwark is AGPL).
//
//   WEBMAIL_ZIP=/path/to.zip  use a local build instead (no checksum check)
//   WEBMAIL_SKIP=1            skip the webmail; /webmail/ then serves its 404
const RELEASES = "https://github.com/wtarit/s8s-mail-webmail/releases/download";
const pin = JSON.parse(await readFile(new URL("../webmail.json", import.meta.url), "utf8"));
const dist = new URL("../dist/", import.meta.url);
const output = new URL("webmail/", dist);
const cache = new URL(`../node_modules/.cache/s8s-webmail/${pin.version}.zip`, import.meta.url);
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

// Served by the Worker (config.json) or by the Worker's routing (_redirects), or not needed.
const SKIP = /^(demo\/|config\.json$|_redirects$|LITE-README\.md$|[^/]+\.example$)/;

async function zipBytes() {
  if (process.env.WEBMAIL_ZIP) {
    console.warn(`webmail: using ${process.env.WEBMAIL_ZIP} (not checksummed)`);
    return readFile(process.env.WEBMAIL_ZIP);
  }
  const cached = await readFile(cache).catch(() => null);
  if (cached && sha256(cached) === pin.sha256) return cached;
  const name = `s8s-webmail-${pin.version}.zip`;
  console.info(`webmail: downloading ${name}`);
  const res = await fetch(`${RELEASES}/${pin.version}/${name}`);
  assert.ok(res.ok, `webmail: download failed: HTTP ${res.status}`);
  const bytes = Buffer.from(await res.arrayBuffer());
  assert.equal(sha256(bytes), pin.sha256, "webmail: checksum mismatch, check webmail.json");
  await mkdir(dirname(fileURLToPath(cache)), { recursive: true });
  await writeFile(cache, bytes);
  return bytes;
}

if (process.env.WEBMAIL_SKIP) {
  console.warn("webmail: skipped (WEBMAIL_SKIP)");
} else {
  const files = unzipSync(await zipBytes(), {
    filter: (file) => !file.name.endsWith("/") && !SKIP.test(file.name),
  });
  await rm(output, { recursive: true, force: true });
  let headers = "";
  for (const [name, bytes] of Object.entries(files)) {
    assert.ok(!normalize(name).startsWith("..") && !name.startsWith("/"), `bad path: ${name}`);
    // Its rules already name /webmail/ paths; Workers only reads _headers at the assets root.
    if (name === "_headers") headers = Buffer.from(bytes).toString("utf8");
    else {
      const target = new URL(name, output);
      await mkdir(dirname(fileURLToPath(target)), { recursive: true });
      await writeFile(target, bytes);
    }
  }
  assert.ok(files["index.html"] && headers, "webmail: not a Lite static build");
  await writeFile(new URL("_headers", dist), headers);
  console.info(`webmail: ${Object.keys(files).length} files in dist/webmail/`);
}
