/* oxlint-disable typescript/no-explicit-any -- JSON responses are read untyped in tests */
import { describe, expect, it } from "vitest";
import { call, deliver, resp, setupAccount } from "../helpers/jmap";
import { getEmails, stateOf } from "../helpers/ingest";

describe("Thread/Mailbox change tracking", () => {
  it("reports threads and mailbox counts as delivery, flagging and destroy happen", async () => {
    const { app, accountId, box } = await setupAccount("chg-1", ["chg-1@example.com"]);
    const inbox = box("inbox");
    const to = "chg-1@example.com";
    const changes = async (type: "Thread" | "Mailbox", sinceState: string) =>
      resp(await call(app, [[`${type}/changes`, { accountId, sinceState }, "c"]])).args;

    // A new thread is created; the inbox counts change.
    const threads0 = await stateOf(app, accountId, "Thread");
    const boxes0 = await stateOf(app, accountId, "Mailbox");
    await deliver(accountId, to, { subject: "Plan", messageId: "<p1@example.com>" });
    const [first] = await getEmails(app, accountId, ["threadId"]);
    const threadId = first!.threadId;
    expect(await changes("Thread", threads0)).toMatchObject({
      created: [threadId],
      updated: [],
      destroyed: [],
    });
    expect(await changes("Mailbox", boxes0)).toMatchObject({ updated: [inbox], created: [] });

    // A reply joins that thread: the thread is updated, not created.
    const threads1 = await stateOf(app, accountId, "Thread");
    await deliver(accountId, to, {
      subject: "Re: Plan",
      messageId: "<p2@example.com>",
      inReplyTo: "<p1@example.com>",
      references: "<p1@example.com>",
    });
    expect(await changes("Thread", threads1)).toMatchObject({
      created: [],
      updated: [threadId],
      destroyed: [],
    });

    // $flagged touches the email only; $seen also changes the inbox's unread count.
    const ids = (await getEmails(app, accountId, ["id"])).map((e) => e.id);
    const boxes1 = await stateOf(app, accountId, "Mailbox");
    const emails1 = await stateOf(app, accountId, "Email");
    await call(app, [
      ["Email/set", { accountId, update: { [ids[0]!]: { "keywords/$flagged": true } } }, "s"],
    ]);
    expect(await stateOf(app, accountId, "Email")).not.toBe(emails1);
    expect(await stateOf(app, accountId, "Mailbox")).toBe(boxes1);
    await call(app, [
      ["Email/set", { accountId, update: { [ids[0]!]: { "keywords/$seen": true } } }, "s"],
    ]);
    expect(await changes("Mailbox", boxes1)).toMatchObject({ updated: [inbox] });

    // Destroying every email of the thread destroys the thread.
    const threads2 = await stateOf(app, accountId, "Thread");
    await call(app, [["Email/set", { accountId, destroy: ids }, "d"]]);
    expect(await changes("Thread", threads2)).toMatchObject({
      created: [],
      updated: [],
      destroyed: [threadId],
    });
    const t = await call(app, [["Thread/get", { accountId, ids: [threadId] }, "t"]]);
    expect(resp(t).args.notFound).toEqual([threadId]);
  });

  it("a message referencing a destroyed one lands in a thread that exists", async () => {
    const { app, accountId } = await setupAccount("chg-2", ["chg-2@example.com"]);
    const to = "chg-2@example.com";
    await deliver(accountId, to, { subject: "Gone", messageId: "<gone@example.com>" });
    const [old] = await getEmails(app, accountId, ["id"]);
    await call(app, [["Email/set", { accountId, destroy: [old!.id] }, "d"]]);

    await deliver(accountId, to, {
      subject: "Re: Gone",
      messageId: "<late@example.com>",
      inReplyTo: "<gone@example.com>",
      references: "<gone@example.com>",
    });
    const [reply] = await getEmails(app, accountId, ["threadId"]);
    const t = await call(app, [["Thread/get", { accountId, ids: [reply!.threadId] }, "t"]]);
    expect(resp(t).args.list).toEqual([{ id: reply!.threadId, emailIds: [reply!.id] }]);
  });
});
