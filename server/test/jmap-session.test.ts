import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { wellKnownJmap } from "../src/jmap";
import { Hono } from "hono";
import { maxAttachmentBytes, getSendProvider } from "../src/send";
import { call, setupAccount, testApp, USING } from "./helpers/jmap";

describe("JMAP session", () => {
  it("advertises capabilities, limits and URLs", async () => {
    const { app } = await setupAccount("sess-1", ["ana@example.com", "sales@example.com"]);
    const res = await app.request("/jmap/session", {}, env);
    expect(res.status).toBe(200);
    const s = (await res.json()) as any;
    const limit = maxAttachmentBytes(getSendProvider(env));

    expect(Object.keys(s.capabilities).sort()).toEqual([
      "urn:ietf:params:jmap:core",
      "urn:ietf:params:jmap:mail",
      "urn:ietf:params:jmap:submission",
    ]);
    expect(JSON.stringify(s)).not.toContain("stalwart");
    expect(s.capabilities["urn:ietf:params:jmap:core"]).toMatchObject({
      maxSizeUpload: limit,
      maxConcurrentUpload: 4,
      maxSizeRequest: 10_000_000,
      maxConcurrentRequests: 4,
      maxCallsInRequest: 32,
      maxObjectsInGet: 256,
      maxObjectsInSet: 128,
      collationAlgorithms: ["i;ascii-casemap", "i;unicode-casemap"],
    });
    expect(limit).toBeGreaterThan(10_000_000);

    const acct = s.accounts["sess-1"];
    expect(acct).toMatchObject({ name: "sess-1", isPersonal: true, isReadOnly: false });
    expect(acct.accountCapabilities["urn:ietf:params:jmap:mail"]).toMatchObject({
      maxMailboxesPerEmail: null,
      maxMailboxDepth: 10,
      maxSizeMailboxName: 255,
      maxSizeAttachmentsPerEmail: limit,
      emailQuerySortOptions: expect.arrayContaining([
        "receivedAt",
        "sentAt",
        "size",
        "from",
        "to",
        "subject",
      ]),
      mayCreateTopLevelMailbox: true,
    });
    expect(acct.accountCapabilities["urn:ietf:params:jmap:submission"]).toEqual({
      maxDelayedSend: 0,
      submissionExtensions: {},
    });
    expect(s.primaryAccounts).toEqual({
      "urn:ietf:params:jmap:mail": "sess-1",
      "urn:ietf:params:jmap:submission": "sess-1",
    });
    expect(s.username).toBe("ana@example.com");
    const base = env.PUBLIC_URL;
    expect(s.apiUrl).toBe(`${base}/jmap/api`);
    expect(s.downloadUrl).toBe(`${base}/jmap/download/{accountId}/{blobId}/{name}?type={type}`);
    expect(s.uploadUrl).toBe(`${base}/jmap/upload/{accountId}/`);
    expect(s.eventSourceUrl).toBe(
      `${base}/jmap/eventsource?types={types}&closeafter={closeafter}&ping={ping}`,
    );
    expect(s.state).toMatch(/^[0-9a-f]+$/);
  });

  it("/.well-known/jmap redirects to the session", async () => {
    const app = new Hono<{ Bindings: Env }>();
    app.get("/.well-known/jmap", wellKnownJmap);
    const res = await app.request("/.well-known/jmap", { redirect: "manual" }, env);
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/jmap/session");
  });
});

describe("JMAP request envelope", () => {
  const post = (app: ReturnType<typeof testApp>, body: BodyInit, type = "application/json") =>
    app.request("/jmap/api", { method: "POST", headers: { "content-type": type }, body }, env);

  it("rejects bad envelopes with request errors", async () => {
    const { app } = await setupAccount("env-1", ["env1@example.com"]);
    let res = await post(app, "{not json");
    expect(res.status).toBe(400);
    expect(((await res.json()) as any).type).toBe("urn:ietf:params:jmap:error:notJSON");

    res = await post(app, JSON.stringify({ using: "x", methodCalls: [] }));
    expect(res.status).toBe(400);
    expect(((await res.json()) as any).type).toBe("urn:ietf:params:jmap:error:notRequest");

    res = await post(app, JSON.stringify({ using: [], methodCalls: [["Core/echo", {}]] }));
    expect(((await res.json()) as any).type).toBe("urn:ietf:params:jmap:error:notRequest");

    res = await post(app, JSON.stringify({ using: ["urn:example:nope"], methodCalls: [] }));
    expect(((await res.json()) as any).type).toBe("urn:ietf:params:jmap:error:unknownCapability");

    res = await post(
      app,
      JSON.stringify({
        using: USING,
        methodCalls: Array.from({ length: 33 }, (_, i) => ["Core/echo", {}, `c${i}`]),
      }),
    );
    const limit = (await res.json()) as any;
    expect(limit).toMatchObject({
      type: "urn:ietf:params:jmap:error:limit",
      limit: "maxCallsInRequest",
    });

    res = await post(app, "{}", "text/plain");
    expect(((await res.json()) as any).type).toBe("urn:ietf:params:jmap:error:notJSON");
  });

  it("keeps running other calls when one has bad arguments or is unknown", async () => {
    const { app, accountId } = await setupAccount("env-2", ["env2@example.com"]);
    const r = await call(app, [
      ["Core/echo", { hello: "world" }, "a"],
      ["Mailbox/get", { accountId, ids: "nope" }, "b"],
      ["Foo/bar", { accountId }, "c"],
      ["Mailbox/get", { accountId: "someone-else" }, "d"],
      ["Mailbox/get", { accountId }, "e"],
      ["Thread/get", { accountId, ids: ["x"], "#ids": { resultOf: "zz", name: "X/y", path: "/a" } }, "f"],
    ]);
    const m = r.methodResponses;
    expect(m[0]).toEqual(["Core/echo", { hello: "world" }, "a"]);
    expect(m[1]![0]).toBe("error");
    expect(m[1]![1].type).toBe("invalidArguments");
    expect(m[2]![1].type).toBe("unknownMethod");
    expect(m[3]![1].type).toBe("accountNotFound");
    expect(m[4]![0]).toBe("Mailbox/get");
    expect(m[5]![1].type).toBe("invalidArguments");
  });

  it("requires the capability in `using` for a method", async () => {
    const { app, accountId } = await setupAccount("env-3", ["env3@example.com"]);
    const r = await call(app, [["Identity/get", { accountId }, "i"]], USING);
    expect(r.methodResponses[0]![1].type).toBe("unknownMethod");
  });

  it("resolves result references (including /*) and returns createdIds", async () => {
    const { app, accountId, box } = await setupAccount("env-4", ["env4@example.com"]);
    await call(app, [["Core/echo", {}, "x"]]);
    const r = await call(
      app,
      [
        ["Mailbox/query", { accountId, filter: { role: "inbox" } }, "q"],
        ["Mailbox/get", { accountId, "#ids": { resultOf: "q", name: "Mailbox/query", path: "/ids" } }, "g"],
        ["Mailbox/get", { accountId, "#ids": { resultOf: "q", name: "Mailbox/get", path: "/ids" } }, "bad"],
        ["Mailbox/get", { accountId, "#ids": { resultOf: "g", name: "Mailbox/get", path: "/list/*/id" } }, "star"],
        ["Mailbox/get", { accountId, "#ids": { resultOf: "g", name: "Mailbox/get", path: "/nothing" } }, "miss"],
        ["Mailbox/set", { accountId, create: { k1: { name: "Projects" } } }, "s"],
        ["Mailbox/set", { accountId, create: { k2: { name: "Sub", parentId: "#k1" } } }, "s2"],
      ],
      USING,
      { createdIds: {} },
    );
    const m = r.methodResponses;
    expect(m[1]![1].list.map((x: any) => x.id)).toEqual([box("inbox")]);
    expect(m[2]![1].type).toBe("invalidResultReference");
    expect(m[3]![1].list).toHaveLength(1);
    expect(m[4]![1].type).toBe("invalidResultReference");
    expect(m[5]![1].created.k1.id).toBeTruthy();
    expect(m[6]![1].created.k2.id).toBeTruthy();
    expect(r.createdIds).toMatchObject({ k1: m[5]![1].created.k1.id, k2: m[6]![1].created.k2.id });
    const g = await call(app, [["Mailbox/get", { accountId, ids: [m[6]![1].created.k2.id] }, "g"]]);
    expect(g.methodResponses[0]![1].list[0].parentId).toBe(m[5]![1].created.k1.id);
  });

  it("enforces maxObjectsInGet", async () => {
    const { app, accountId } = await setupAccount("env-5", ["env5@example.com"]);
    const ids = Array.from({ length: 257 }, (_, i) => `x${i}`);
    const r = await call(app, [["Email/get", { accountId, ids }, "g"]]);
    expect(r.methodResponses[0]![1].type).toBe("requestTooLarge");
  });
});
