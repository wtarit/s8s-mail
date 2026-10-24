import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

// The npm package embeds Wasm bytes and compiles them at runtime, which Workers
// disallows. Adapt only its loader; preserve the reviewed cryptography verbatim.
// Review all pinned hashes and the transformation together before any upgrade.
const expected = {
  version: "1.1.0",
  source: "1e8d56383a77948e453085b6d4f52dcb9645f8bfff32395738b63d3a2e2fcb52",
  wasm: "32255973125fe9ac1fdf54d7f152361b302299f4b6678a1cb1c9baa978f0d6db",
  adapted: "cdc9e5127373441a53adddf77accb707f66aa3a2937541dc778753c26008b726",
  license: "f8d4901346dafc59a2778f1303d57d84cf0a5682c14625f9cc2af26245576555",
};
const output = new URL("../src/auth/.generated/", import.meta.url);
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

try {
  const require = createRequire(import.meta.url);
  const packageRoot = dirname(require.resolve("@serenity-kit/opaque/package.json"));
  const manifest = JSON.parse(await readFile(join(packageRoot, "package.json"), "utf8"));
  assert.equal(manifest.version, expected.version, "Review the loader before upgrading Serenity");
  const sourceBytes = await readFile(join(packageRoot, "esm/index.js"));
  assert.equal(sha256(sourceBytes), expected.source, "Unexpected published Serenity source");
  const source = sourceBytes.toString("utf8");
  const marker =
    /^function wasmData\(imports\)\{return _loadWasmModule\(0, null, '([A-Za-z0-9+/=]+)'\)\}\r?\n/gm;
  const matches = [...source.matchAll(marker)];
  assert.equal(matches.length, 1, "Expected exactly one embedded Wasm module");
  const match = matches[0];
  assert.match(source.slice(0, match.index), /^function _loadWasmModule/);
  const wasm = Buffer.from(match[1], "base64");
  assert.equal(sha256(wasm), expected.wasm, "Unexpected embedded Serenity Wasm");
  assert.equal(wasm.subarray(0, 4).toString("hex"), "0061736d");

  const suffix = source.slice(match.index + match[0].length);
  const oldInit = "module_or_path: wasmData()";
  assert.equal(suffix.split(oldInit).length, 2, "Expected exactly one automatic initializer");
  const adapted =
    'import opaqueModule from "./opaque_bg.wasm";\n' +
    suffix.replace(oldInit, "module_or_path: opaqueModule");
  assert.equal(sha256(adapted), expected.adapted, "Unexpected Serenity loader transformation");
  assert.ok(!adapted.includes("WebAssembly.compile"));
  const license = await readFile(join(packageRoot, "LICENSE"), "utf8");
  assert.equal(sha256(license), expected.license, "Unexpected Serenity license notice");
  const notice = `Serenity OPAQUE ${expected.version}: https://github.com/serenity-kit/opaque
Published package: https://www.npmjs.com/package/@serenity-kit/opaque/v/${expected.version}
This directory contains the unchanged published Wasm and its JavaScript wrapper,
with only inline runtime compilation replaced by a static Wasm module import.
The original copyright and permission notice follow.

${license}`;
  // Preserve the MIT notice in both the generated directory and the bundled
  // JavaScript. esbuild/Wrangler retains this legal comment in distributions.
  const licensedAdapted = `/*!\n${notice}*/\n${adapted}`;

  await mkdir(output, { recursive: true });
  await writeFile(new URL("opaque_bg.wasm", output), wasm);
  await writeFile(new URL("opaque-worker.mjs", output), licensedAdapted);
  await writeFile(
    new URL("opaque-worker.d.mts", output),
    "export declare const ready: Promise<void>;\n" +
      'export declare const server: typeof import("@serenity-kit/opaque").server;\n' +
      'export declare const client: typeof import("@serenity-kit/opaque").client;\n',
  );
  await writeFile(new URL("LICENSE", output), license);
  await writeFile(new URL("NOTICE", output), notice);
  await writeFile(
    new URL("provenance.json", output),
    JSON.stringify(
      {
        package: "@serenity-kit/opaque",
        version: manifest.version,
        publishedEsmSha256: expected.source,
        extractedWasmSha256: expected.wasm,
        wasmBytes: wasm.length,
        adaptedLoaderSha256: expected.adapted,
        adaptedEsmSha256: sha256(licensedAdapted),
        licenseSha256: expected.license,
        transformation: "Remove inline loader; import unchanged Wasm; use existing initializer",
      },
      null,
      2,
    ) + "\n",
  );
  console.info(`Prepared verified Serenity OPAQUE ${expected.version} static Wasm`);
} catch (error) {
  // A failed review must not leave a previously generated runtime available.
  await rm(output, { recursive: true, force: true });
  throw error;
}
