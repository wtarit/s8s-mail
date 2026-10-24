import { afterEach, describe, expect, it, vi } from "vitest";
import { createCryptoWorker } from "./worker-client";

class FakeWorker {
  static last: FakeWorker;
  onmessage?: (event: { data: unknown }) => void;
  onerror?: () => void;
  onmessageerror?: () => void;
  terminate = vi.fn();
  postMessage = vi.fn();
  addEventListener(type: string, listener: (event: never) => void) {
    Object.assign(this, { ["on" + type]: listener });
  }
  constructor() {
    FakeWorker.last = this;
  }
}
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("OPAQUE dedicated worker lifecycle", () => {
  it("returns only the matching command result and terminates explicitly", async () => {
    vi.stubGlobal("Worker", FakeWorker);
    const worker = createCryptoWorker();
    const result = worker.run({ type: "login-start", password: "secret" });
    FakeWorker.last.onmessage?.({ data: { id: 10, result: {} } });
    FakeWorker.last.onmessage?.({ data: { id: 0, result: { startLoginRequest: "request" } } });
    expect(await result).toEqual({ startLoginRequest: "request" });
    worker.close();
    expect(FakeWorker.last.terminate).toHaveBeenCalledOnce();
  });
  it("terminates and rejects pending work on timeout", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("Worker", FakeWorker);
    const worker = createCryptoWorker();
    const result = worker.run({ type: "login-start", password: "secret" });
    const rejected = expect(result).rejects.toMatchObject({ code: "OPAQUE_TIMEOUT" });
    await vi.advanceTimersByTimeAsync(60000);
    await rejected;
    expect(FakeWorker.last.terminate).toHaveBeenCalledOnce();
  });
  it("terminates on worker errors and fails when workers are unsupported", async () => {
    vi.stubGlobal("Worker", FakeWorker);
    const worker = createCryptoWorker();
    const result = worker.run({ type: "login-start", password: "secret" });
    FakeWorker.last.onerror?.();
    await expect(result).rejects.toMatchObject({ code: "OPAQUE_FAILED" });
    expect(FakeWorker.last.terminate).toHaveBeenCalledOnce();
    vi.stubGlobal("Worker", undefined);
    expect(() => createCryptoWorker()).toThrow("OPAQUE_UNAVAILABLE");
  });
});
