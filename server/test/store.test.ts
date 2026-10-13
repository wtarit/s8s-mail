import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { accountStub } from "../src/store/subscribe";
import { newMessageBlobId, parseBlobId, partBlobId } from "../src/store/blob";
import { normalizeMessageId, threadCandidates } from "../src/store/threading";
import type { IngestInput } from "../src/store/types";

export function ingestInput(
  accountId: string,
  over: Partial<IngestInput["headers"]> = {},
): IngestInput {
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

type LogRow = { type: string; object_id: string; kind: string };

async function changeLog(stub: ReturnType<typeof accountStub>): Promise<LogRow[]> {
  return runInDurableObject(stub, (_i, state) =>
    state.storage.sql
      .exec<LogRow>("SELECT type, object_id, kind FROM change_log ORDER BY seq")
      .toArray(),
  );
}

describe("AccountDO store", () => {
  it("runs migrations and creates the schema", async () => {
    const stub = accountStub(env, "store-schema");
    const tables = await stub.listTables();
    for (const t of [
      "meta",
      "mailbox",
      "email",
      "email_mailbox",
      "email_keyword",
      "thread_ref",
      "change_log",
      "email_fts",
    ]) {
      expect(tables).toContain(t);
    }
  });

  it("seeds the RFC 8621 system mailboxes once", async () => {
    const stub = accountStub(env, "store-mailboxes");
    await stub.init("store-mailboxes");
    const rows = await runInDurableObject(stub, (_i, state) =>
      state.storage.sql
        .exec<{ name: string; role: string }>("SELECT name, role FROM mailbox ORDER BY sort_order")
        .toArray(),
    );
    expect(rows.map((r) => r.role)).toEqual([
      "inbox",
      "drafts",
      "sent",
      "junk",
      "trash",
      "archive",
    ]);
    expect(rows[0]!.name).toBe("Inbox");
    // Seeding is logged as Mailbox "created", so the state is non-zero from the start.
    expect((await stub.getState()).Mailbox).toBe("6");
  });

  it("stores the accountId in meta and refuses a different one", async () => {
    const stub = accountStub(env, "store-meta");
    await stub.init("store-meta");
    await stub.init("store-meta");
    expect(await stub.getMeta("accountId")).toBe("store-meta");
    let error: unknown;
    try {
      await stub.init("someone-else");
    } catch (e) {
      error = e;
    }
    expect(String(error)).toMatch(/belongs to account/);
  });

  it("ingest is idempotent per blobId", async () => {
    const stub = accountStub(env, "store-idem");
    const input = ingestInput("store-idem");
    const a = await stub.ingest(input);
    const b = await stub.ingest(input);
    expect(b).toEqual(a);
    const n = await runInDurableObject(
      stub,
      (_i, state) =>
        state.storage.sql.exec<{ n: number }>("SELECT count(*) AS n FROM email").one().n,
    );
    expect(n).toBe(1);
  });

  it("logs changes by trigger and derives per-type state", async () => {
    const stub = accountStub(env, "store-log");
    const before = await stub.getState();
    expect(before).toMatchObject({ Email: "0", Thread: "0", EmailDelivery: "0" });

    const { emailId, threadId } = await stub.ingest(ingestInput("store-log"));
    const log = await changeLog(stub);
    const forEmail = log.filter((r) => r.object_id === emailId).map((r) => `${r.type}:${r.kind}`);
    expect(forEmail).toContain("Email:created");
    expect(forEmail).toContain("EmailDelivery:created");
    expect(log).toContainEqual({ type: "Thread", object_id: threadId, kind: "created" });
    // Membership insert changes the inbox counts.
    expect(log.filter((r) => r.type === "Mailbox" && r.kind === "updated")).toHaveLength(1);

    const after = await stub.getState();
    expect(Number(after.Email)).toBeGreaterThan(0);
    expect(Number(after.Thread)).toBeGreaterThan(0);
    expect(Number(after.Mailbox)).toBeGreaterThan(Number(before.Mailbox));
  });

  it("logs keyword, membership and destroy changes", async () => {
    const stub = accountStub(env, "store-triggers");
    const { emailId, threadId } = await stub.ingest(ingestInput("store-triggers"));
    const start = (await changeLog(stub)).length;

    await runInDurableObject(stub, (_i, state) => {
      const s = state.storage.sql;
      s.exec("INSERT INTO email_keyword (email_id, keyword) VALUES (?, '$flagged')", emailId);
      s.exec("INSERT INTO email_keyword (email_id, keyword) VALUES (?, '$seen')", emailId);
    });
    let log = (await changeLog(stub)).slice(start);
    // $flagged: Email only. $seen: Email + the (inbox) Mailbox's unread count.
    expect(log.map((r) => `${r.type}:${r.kind}`)).toEqual([
      "Email:updated",
      "Email:updated",
      "Mailbox:updated",
    ]);

    const mid = (await changeLog(stub)).length;
    await runInDurableObject(stub, (_i, state) => {
      state.storage.sql.exec("DELETE FROM email WHERE id = ?", emailId);
    });
    log = (await changeLog(stub)).slice(mid);
    expect(log).toContainEqual({ type: "Email", object_id: emailId, kind: "destroyed" });
    expect(log).toContainEqual({ type: "Thread", object_id: threadId, kind: "destroyed" });
    const refs = await runInDurableObject(
      stub,
      (_i, state) =>
        state.storage.sql.exec<{ n: number }>("SELECT count(*) AS n FROM thread_ref").one().n,
    );
    expect(refs).toBe(0);
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

    // Unrelated mail gets its own thread; a second email in a thread logs Thread "updated".
    const other = await stub.ingest(ingestInput("store-threads"));
    expect(other.threadId).not.toBe(root.threadId);
    const log = await changeLog(stub);
    expect(
      log.filter((r) => r.type === "Thread" && r.object_id === root.threadId).map((r) => r.kind),
    ).toEqual(["created", "updated", "updated"]);
  });

  it("deleteAll wipes the store, returns all blob ids and leaves a fresh empty store", async () => {
    const stub = accountStub(env, "store-delete");
    const input = ingestInput("store-delete");
    await stub.ingest(input);
    // Pretend the parse produced part blobs.
    await runInDurableObject(stub, (_i, state) => {
      state.storage.sql.exec(
        "UPDATE email SET body_structure = ? WHERE blob_id = ?",
        JSON.stringify({
          partId: null,
          blobId: null,
          subParts: [{ partId: "1", blobId: partBlobId(input.blobId, "1"), subParts: null }],
        }),
        input.blobId,
      );
    });
    const ids = await stub.deleteAll();
    expect(ids.toSorted()).toEqual([input.blobId, partBlobId(input.blobId, "1")].toSorted());

    const counts = await runInDurableObject(stub, (_i, state) => {
      const one = (q: string) => state.storage.sql.exec<{ n: number }>(q).one().n;
      return {
        emails: one("SELECT count(*) AS n FROM email"),
        refs: one("SELECT count(*) AS n FROM thread_ref"),
        mailboxes: one("SELECT count(*) AS n FROM mailbox"),
        log: one("SELECT count(*) AS n FROM change_log WHERE type = 'Email'"),
      };
    });
    expect(counts).toEqual({ emails: 0, refs: 0, mailboxes: 6, log: 0 });
    expect(await stub.getMeta("accountId")).toBeNull();
    expect((await stub.getState()).Email).toBe("0");
    // ... and the account can be used again.
    await stub.ingest(ingestInput("store-delete"));
  });
});

describe("blob ids and threading helpers", () => {
  it("builds valid JMAP ids and splits part blob ids", () => {
    const id = newMessageBlobId();
    expect(id).toMatch(/^M[0-9a-f]{32}$/);
    const part = partBlobId(id, "3");
    expect(part).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(parseBlobId(part)).toEqual({ messageBlobId: id, partId: "3" });
    expect(parseBlobId(id)).toEqual({ messageBlobId: id, partId: null });
  });

  it("orders thread candidates: own id, In-Reply-To, References newest first", () => {
    expect(normalizeMessageId(" <A@Example.com> ")).toBe("a@example.com");
    expect(threadCandidates("Me@x", ["P@x"], ["r1@x", "r2@x", "p@x"])).toEqual([
      "me@x",
      "p@x",
      "r2@x",
      "r1@x",
    ]);
    expect(threadCandidates(null, [], [])).toEqual([]);
  });
});
