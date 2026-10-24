// Generated from the pinned, hash-verified npm package by opaque:prepare. Never
// import the package's runtime entry on Workers: it compiles inline Wasm bytes.
import { ready, server } from "./.generated/opaque-worker.mjs";

// Client operations are exported for workerd protocol tests. Production uses
// only server operations; the unused client export is removed by tree shaking.
export { ready, server, client } from "./.generated/opaque-worker.mjs";

export async function getOpaqueServer(): Promise<typeof server> {
  await ready;
  return server;
}
