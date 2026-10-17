/* oxlint-disable typescript/no-explicit-any -- JSON responses are read untyped in tests */
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { accountStub } from "../../src/store/subscribe";
import { newMessageBlobId, parseBlobId, partBlobId } from "../../src/store/blob";
import type { IngestInput } from "../../src/store/types";
import { call, deliver, resp, setupAccount } from "../helpers/jmap";
import { getEmails, searchIds, settleParse } from "../helpers/ingest";

function ingestInput(accountId: string, over: Partial<IngestInput["headers"]> = {}): IngestInput {
  return {
    accountId,
    blobId: newMessageBlobId(),
    size: 100,
    receivedAt: Date.now(),
    headers: {
      messageId: `${crypto.randomUUID()}@example.com`,
      inReplyTo: [],
      references: [],
      subject: "Hi",
      sentAt: null,
      from: [{ name: "Bob", email: "bob@example.com" }],
      sender: [],
      to: [{ name: null, email: "ana@example.com" }],
      cc: [],
      replyTo: [],
      ...over,
    },
    envelope: { mailFrom: "bob@example.com", rcptTo: "ana@example.com" },
    mailboxRole: "inbox",
  };
}

type Part = { blobId: string | null; subParts: Part[] | null };
const leafBlobIds = (p: Part): string[] =>
  p.subParts ? p.subParts.flatMap(leafBlobIds) : p.blobId ? [p.blobId] : [];

describe("AccountDO store", () => {
  it("seeds the RFC 8621 system mailboxes once", async () => {
    const stub = accountStub(env, "store-mailboxes");
    await stub.init("store-mailboxes");
    await stub.init("store-mailboxes");
    const { list } = await stub.mailboxGet(null);
    const ordered = list.toSorted((a, b) => a.sortOrder - b.sortOrder);
    expect(ordered.map((m) => m.role)).toEqual([
      "inbox",
      "drafts",
      "sent",
      "junk",
      "trash",
      "archive",
    ]);
    expect(ordered[0]!.name).toBe("Inbox");
  });

  it("stores the accountId in meta and refuses a different one", async () => {
    const stub = accountStub(env, "store-meta");
    await stub.init("store-meta");
    await stub.init("store-meta");
    expect(await stub.getMeta("accountId")).toBe("store-meta");
    // (wrapped: an RPC promise left unawaited by `rejects` would surface as an unhandled rejection)
    await expect((async () => stub.init("someone-else"))()).rejects.toThrow();
    expect(await stub.getMeta("accountId")).toBe("store-meta");
  });

  it("ingest is idempotent per blobId", async () => {
    const stub = accountStub(env, "store-idem");
    const input = ingestInput("store-idem");
    const a = await stub.ingest(input);
    const stateAfterFirst = await stub.getState();
    const b = await stub.ingest(input);
    expect(b).toEqual(a);
    // One email, and the second ingest changed nothing clients could see.
    expect((await stub.threadGet([a.threadId])).list).toEqual([
      { id: a.threadId, emailIds: [a.emailId] },
    ]);
    expect(await stub.getState()).toEqual(stateAfterFirst);
  });

  it("joins replies to the thread (In-Reply-To, References, out of order)", async () => {
    const stub = accountStub(env, "store-threads");
    const root = await stub.ingest(ingestInput("store-threads", { messageId: "root@example.com" }));
    const reply = await stub.ingest(
      ingestInput("store-threads", {
        messageId: "reply1@example.com",
        inReplyTo: ["root@example.com"],
        references: ["root@example.com"],
      }),
    );
    expect(reply.threadId).toBe(root.threadId);

    // Matches only through References, case-insensitively.
    const deep = await stub.ingest(
      ingestInput("store-threads", {
        messageId: "reply2@example.com",
        references: ["ROOT@example.com", "reply1@example.com"],
      }),
    );
    expect(deep.threadId).toBe(root.threadId);

    // A reply that arrives before its parent starts a thread the parent then joins.
    const early = await stub.ingest(
      ingestInput("store-threads", {
        messageId: "late-child@example.com",
        inReplyTo: ["late-parent@example.com"],
      }),
    );
    const parent = await stub.ingest(
      ingestInput("store-threads", { messageId: "late-parent@example.com" }),
    );
    expect(parent.threadId).toBe(early.threadId);

    // Unrelated mail gets its own thread.
    const other = await stub.ingest(ingestInput("store-threads"));
    expect(other.threadId).not.toBe(root.threadId);
  });

  it("deleteAll wipes the store, returns all blob ids and leaves a fresh empty store", async () => {
    const { app, accountId } = await setupAccount("store-delete", ["store-delete@example.com"]);
    await deliver(accountId, "store-delete@example.com", {
      attachment: { filename: "a.txt", mimeType: "text/plain", base64: btoa("hello") },
    });
    await settleParse(accountId);
    const [email] = await getEmails(app, accountId, ["blobId", "threadId", "bodyStructure"]);
    // The caller deletes these from R2: the raw message and every decoded part.
    const expected = [email!.blobId, ...leafBlobIds(email!.bodyStructure)];
    expect(expected.length).toBeGreaterThan(2);

    const stub = accountStub(env, accountId);
    expect((await stub.deleteAll()).toSorted()).toEqual(expected.toSorted());

    expect(await stub.getMeta("accountId")).toBeNull();
    const r = await call(app, [
      ["Email/get", { accountId, ids: [email!.id], properties: ["id"] }, "e"],
      ["Thread/get", { accountId, ids: [email!.threadId] }, "t"],
      ["Mailbox/get", { accountId }, "m"],
    ]);
    expect(resp(r, 0).args.notFound).toEqual([email!.id]);
    expect(resp(r, 1).args.notFound).toEqual([email!.threadId]);
    const boxes = resp(r, 2).args.list;
    expect(boxes).toHaveLength(6);
    expect(boxes.map((m: any) => m.totalEmails)).toEqual([0, 0, 0, 0, 0, 0]);
    expect(await searchIds(app, accountId)).toEqual([]);

    // ... and the account can be used again.
    await deliver(accountId, "store-delete@example.com", { messageId: "<again@example.com>" });
    expect(await searchIds(app, accountId)).toHaveLength(1);
  });
});

describe("blob ids", () => {
  it("builds valid JMAP ids and splits part blob ids", () => {
    // RFC 8620 §1.2: 1-255 characters of A-Z a-z 0-9 - _
    const jmapId = /^[A-Za-z0-9_-]{1,255}$/;
    const id = newMessageBlobId();
    expect(id).toMatch(jmapId);
    expect(newMessageBlobId()).not.toBe(id);
    const part = partBlobId(id, "3");
    expect(part).toMatch(jmapId);
    expect(parseBlobId(part)).toEqual({ messageBlobId: id, partId: "3" });
    expect(parseBlobId(id)).toEqual({ messageBlobId: id, partId: null });
  });
});
