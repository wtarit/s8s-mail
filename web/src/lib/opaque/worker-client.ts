import type { Command, Failure, ProtocolResult } from "./protocol";

export class OpaqueError extends Error {
  constructor(readonly code: Failure | "OPAQUE_UNAVAILABLE" | "OPAQUE_TIMEOUT") {
    super(code);
  }
}

/** A fresh worker for each operation, always terminated by the transport's finally block. */
export function createCryptoWorker() {
  if (typeof Worker === "undefined") throw new OpaqueError("OPAQUE_UNAVAILABLE");
  let worker: Worker;
  try {
    worker = new Worker(new URL("./crypto.worker.ts", import.meta.url), { type: "module" });
  } catch {
    throw new OpaqueError("OPAQUE_UNAVAILABLE");
  }
  let nextId = 0;
  let closed = false;
  const pending = new Map<
    number,
    { resolve: (value: ProtocolResult) => void; reject: (error: OpaqueError) => void }
  >();
  const close = (error = new OpaqueError("OPAQUE_FAILED")) => {
    if (closed) return;
    closed = true;
    clearTimeout(timer);
    worker.terminate();
    for (const value of pending.values()) value.reject(error);
    pending.clear();
  };
  const timer = setTimeout(() => close(new OpaqueError("OPAQUE_TIMEOUT")), 60000);
  worker.addEventListener(
    "message",
    (event: MessageEvent<{ id: number; result?: ProtocolResult; error?: Failure }>) => {
      const value = pending.get(event.data.id);
      if (!value) return;
      pending.delete(event.data.id);
      if (event.data.error) value.reject(new OpaqueError(event.data.error));
      else if (event.data.result) value.resolve(event.data.result);
      else value.reject(new OpaqueError("OPAQUE_FAILED"));
    },
  );
  worker.addEventListener("error", () => close());
  worker.addEventListener("messageerror", () => close());
  return {
    run(command: Command): Promise<ProtocolResult> {
      if (closed) return Promise.reject(new OpaqueError("OPAQUE_TIMEOUT"));
      const id = nextId++;
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject });
        worker.postMessage({ id, command }, { transfer: [] });
      });
    },
    close,
  };
}
