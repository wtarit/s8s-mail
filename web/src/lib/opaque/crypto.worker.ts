import { createProtocol, ProtocolError, type Command } from "./protocol";

// Loaded only in a dedicated browser worker; Argon2 never blocks the UI thread.
const protocol = import("@serenity-kit/opaque").then(async (opaque) => {
  await opaque.ready;
  return createProtocol(opaque);
});
self.addEventListener("message", async (event: MessageEvent<{ id: number; command: Command }>) => {
  const { id, command } = event.data;
  try {
    const run = await protocol;
    self.postMessage({ id, result: run(command) }, { transfer: [] });
  } catch (error) {
    self.postMessage(
      { id, error: error instanceof ProtocolError ? error.code : "OPAQUE_FAILED" },
      { transfer: [] },
    );
  }
});
