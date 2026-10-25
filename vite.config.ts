import { cloudflare } from "@cloudflare/vite-plugin";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { chmodSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig, type Plugin } from "vite";

const repo = (path: string) => fileURLToPath(new URL(path, import.meta.url));

// The plugin copies the declared secrets from .dev.vars into dist/.dev.vars for `vite preview`
// (wrangler deploy does not upload it). Keep that copy as private as the original.
const privateDevVars: Plugin = {
  name: "s8s:private-dev-vars",
  apply: "build",
  writeBundle(options, bundle) {
    if (options.dir && ".dev.vars" in bundle) chmodSync(join(options.dir, ".dev.vars"), 0o600);
  },
};

// The whole app: the SPA (Vite root web/) and the Worker (main in wrangler.jsonc), served
// together by `vite dev` and built together by `vite build`. They must be built together: a
// Worker-only build silently drops `assets` from the generated config.
//
// S8S_WRANGLER_CONFIG picks another config, e.g. the gitignored wrangler.local.jsonc for a
// deploy. The build writes dist/wrangler.json, which is what `wrangler deploy -c` takes.
export default defineConfig({
  root: repo("./web"),
  plugins: [
    react(),
    tailwindcss(),
    cloudflare({
      configPath: repo(process.env.S8S_WRANGLER_CONFIG ?? "./wrangler.jsonc"),
      // The same local D1/DO/R2 data as `pnpm db:migrate:local` (default: web/.wrangler).
      persistState: { path: repo("./.wrangler/state") },
    }),
    privateDevVars,
  ],
  resolve: {
    alias: { "@": repo("./web/src") },
  },
  // PUBLIC_URL in wrangler.jsonc is http://localhost:8787 (Better Auth's origin checks).
  server: { port: 8787, strictPort: true },
  preview: { port: 8787, strictPort: true },
  environments: {
    client: { build: { outDir: repo("./web/dist"), emptyOutDir: true } },
    s8s_mail: { build: { outDir: repo("./dist"), emptyOutDir: true, minify: true } },
  },
});
