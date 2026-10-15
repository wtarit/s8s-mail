/* oxlint-disable typescript/no-explicit-any -- JSON responses are read untyped in tests */
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { setupAccount } from "../helpers/jmap";
import { bytes, upload } from "../helpers/jmap-send";

describe("upload and download", () => {
  it("stores uploads in R2 and serves them back with safe headers, per account", async () => {
    const a = await setupAccount("up-1", ["up-1@example.com"]);
    const b = await setupAccount("up-2", ["up-2@example.com"]);
    const { res, json } = await upload(a.app, a.accountId, bytes("hello attachment"), "text/plain");
    expect(res.status).toBe(201);
    expect(json).toMatchObject({ accountId: "up-1", type: "text/plain", size: 16 });
    expect(json.blobId).toMatch(/^[A-Za-z0-9_-]{1,255}$/);

    const dl = await a.app.request(
      `/jmap/download/up-1/${json.blobId}/${encodeURIComponent('résumé "x".txt')}?type=text%2Fplain`,
      {},
      env,
    );
    expect(dl.status).toBe(200);
    expect(await dl.text()).toBe("hello attachment");
    expect(dl.headers.get("content-type")).toBe("text/plain");
    expect(dl.headers.get("cache-control")).toBe("private, immutable, max-age=31536000");
    const cd = dl.headers.get("content-disposition")!;
    expect(cd).toContain("attachment;");
    expect(cd).toContain("filename*=UTF-8''r%C3%A9sum%C3%A9%20%22x%22.txt");
    expect(cd).toContain('filename="r_sum_ _x_.txt"');
    expect(dl.headers.get("x-content-type-options")).toBe("nosniff");

    // another account's session cannot read it, nor can the blob be named across accounts
    const other = await b.app.request(`/jmap/download/up-2/${json.blobId}/x.txt`, {}, env);
    expect(other.status).toBe(404);
    const foreign = await b.app.request(`/jmap/download/up-1/${json.blobId}/x.txt`, {}, env);
    expect(foreign.status).toBe(404);
    const traversal = await a.app.request(`/jmap/download/up-1/..%2Fup-2%2Fx/x.txt`, {}, env);
    expect(traversal.status).toBe(404);
    // cannot upload into someone else's account
    const bad = await b.app.request(
      "/jmap/upload/up-1/",
      { method: "POST", headers: { "content-type": "text/plain" }, body: "x" },
      env,
    );
    expect(bad.status).toBe(404);
  });

  it("rejects uploads over maxSizeUpload with 413 and a JMAP problem body", async () => {
    const a = await setupAccount("up-3", ["up-3@example.com"]);
    const session = (await (await a.app.request("/jmap/session", {}, env)).json()) as any;
    const max = session.capabilities["urn:ietf:params:jmap:core"].maxSizeUpload as number;
    const res = await a.app.request(
      "/jmap/upload/up-3/",
      {
        method: "POST",
        headers: { "content-type": "application/octet-stream", "content-length": String(max + 1) },
        body: new Uint8Array(8),
      },
      env,
    );
    expect(res.status).toBe(413);
    expect(res.headers.get("content-type")).toContain("application/problem+json");
    expect(await res.json()).toMatchObject({
      type: "urn:ietf:params:jmap:error:limit",
      limit: "maxSizeUpload",
    });
  });
});
