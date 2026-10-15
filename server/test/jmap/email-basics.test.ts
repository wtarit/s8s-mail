/* oxlint-disable typescript/no-explicit-any -- JSON responses are read untyped in tests */
import { describe, expect, it } from "vitest";
import { call, deliver, resp, setupAccount } from "../helpers/jmap";

async function inboxState(app: any, accountId: string, inbox: string) {
  const r = await call(app, [["Mailbox/get", { accountId, ids: [inbox] }, "m"]]);
  return r.methodResponses[0]![1];
}

describe("mailboxes, emails and counts", () => {
  it("ingest -> Mailbox/get counts, Email/query, Thread, Email/get bodies", async () => {
    const { app, accountId, box } = await setupAccount("jm-1", ["jm-1@example.com"]);
    const inbox = box("inbox");
    await deliver(accountId, `${accountId}@example.com`, {
      subject: "First",
      messageId: "<a1@example.com>",
      text: "Hello Ana, first body",
      date: "Mon, 12 Oct 2026 10:00:00 +0000",
    });
    await deliver(accountId, `${accountId}@example.com`, {
      subject: "Re: First",
      messageId: "<a2@example.com>",
      inReplyTo: "<a1@example.com>",
      references: "<a1@example.com>",
      text: "Second body about pineapples",
      date: "Mon, 12 Oct 2026 11:00:00 +0000",
    });
    await deliver(accountId, `${accountId}@example.com`, {
      subject: "Other",
      messageId: "<b1@example.com>",
      text: "Unrelated",
      date: "Mon, 12 Oct 2026 12:00:00 +0000",
    });

    const mb = await inboxState(app, accountId, inbox);
    expect(mb.list[0]).toMatchObject({
      id: inbox,
      name: "Inbox",
      role: "inbox",
      parentId: null,
      totalEmails: 3,
      unreadEmails: 3,
      totalThreads: 2,
      unreadThreads: 2,
      isSubscribed: true,
      myRights: { mayReadItems: true, mayDelete: true, maySubmit: true },
    });

    const q = await call(app, [
      ["Email/query", { accountId, filter: { inMailbox: inbox }, calculateTotal: true }, "q"],
      [
        "Email/query",
        {
          accountId,
          filter: { inMailbox: inbox },
          collapseThreads: true,
          calculateTotal: true,
          sort: [{ property: "receivedAt", isAscending: false }],
        },
        "qc",
      ],
    ]);
    expect(resp(q, 0).args.total).toBe(3);
    expect(resp(q, 0).args.ids).toHaveLength(3);
    expect(resp(q, 1).args.total).toBe(2);
    expect(resp(q, 1).args.ids).toHaveLength(2);
    expect(resp(q, 0).args.canCalculateChanges).toBe(false);

    const g = await call(app, [
      ["Email/query", { accountId, sort: [{ property: "receivedAt", isAscending: true }] }, "q"],
      [
        "Email/get",
        {
          accountId,
          "#ids": { resultOf: "q", name: "Email/query", path: "/ids" },
          properties: [
            "id",
            "threadId",
            "mailboxIds",
            "keywords",
            "subject",
            "from",
            "to",
            "receivedAt",
            "sentAt",
            "preview",
            "hasAttachment",
            "textBody",
            "htmlBody",
            "bodyValues",
            "messageId",
            "inReplyTo",
            "references",
            "blobId",
            "size",
            "attachments",
            "bodyStructure",
          ],
          fetchTextBodyValues: true,
          fetchHTMLBodyValues: true,
          fetchAllBodyValues: true,
          maxBodyValueBytes: 256000,
        },
        "g",
      ],
      [
        "Thread/get",
        { accountId, "#ids": { resultOf: "g", name: "Email/get", path: "/list/*/threadId" } },
        "t",
      ],
    ]);
    const list = resp(g, 1).args.list;
    expect(list.map((e: any) => e.subject)).toEqual(["First", "Re: First", "Other"]);
    const first = list[0];
    expect(first.mailboxIds).toEqual({ [inbox]: true });
    expect(first.keywords).toEqual({});
    expect(first.from).toEqual([{ name: "Bob", email: "bob@example.com" }]);
    expect(first.to).toEqual([{ name: null, email: "jm-1@example.com" }]);
    expect(first.sentAt).toBe("2026-10-12T10:00:00Z");
    expect(first.messageId).toEqual(["a1@example.com"]);
    expect(list[1].inReplyTo).toEqual(["a1@example.com"]);
    expect(first.preview).toBe("Hello Ana, first body");
    expect(first.hasAttachment).toBe(false);
    expect(first.textBody).toHaveLength(1);
    const partId = first.textBody[0].partId;
    expect(first.bodyValues[partId]).toEqual({
      value: "Hello Ana, first body\n",
      isEncodingProblem: false,
      isTruncated: false,
    });
    expect(first.bodyStructure.type).toBe("text/plain");
    expect(first.blobId).toMatch(/^M[0-9a-f]{32}$/);
    expect(list[0].threadId).toBe(list[1].threadId);
    expect(list[2].threadId).not.toBe(list[0].threadId);

    const threads = resp(g, 2).args;
    const tid = list[0].threadId;
    expect(threads.list.find((t: any) => t.id === tid).emailIds).toEqual([list[0].id, list[1].id]);

    // maxBodyValueBytes truncation
    const trunc = await call(app, [
      [
        "Email/get",
        {
          accountId,
          ids: [first.id],
          properties: ["bodyValues"],
          fetchTextBodyValues: true,
          maxBodyValueBytes: 5,
        },
        "g",
      ],
    ]);
    expect(resp(trunc).args.list[0].bodyValues[partId]).toMatchObject({
      value: "Hello",
      isTruncated: true,
    });
  });

  it("$seen patch moves unread counts and shows up in Mailbox/changes (counts only)", async () => {
    const { app, accountId, box } = await setupAccount("jm-2", ["jm-2@example.com"]);
    const inbox = box("inbox");
    await deliver(accountId, `${accountId}@example.com`, {
      subject: "One",
      messageId: "<s1@example.com>",
    });
    await deliver(accountId, `${accountId}@example.com`, {
      subject: "Two",
      messageId: "<s2@example.com>",
    });
    const before = await call(app, [
      ["Mailbox/get", { accountId, ids: [inbox] }, "m"],
      ["Email/query", { accountId }, "q"],
    ]);
    const mbState = resp(before, 0).args.state;
    const [e1] = resp(before, 1).args.ids;
    const emailState = (
      await call(app, [["Email/get", { accountId, ids: [e1], properties: ["id"] }, "g"]])
    ).methodResponses[0]![1].state;

    const set = await call(app, [
      ["Email/set", { accountId, update: { [e1]: { "keywords/$seen": true } } }, "s"],
    ]);
    expect(resp(set).args).toMatchObject({ updated: { [e1]: null }, oldState: emailState });
    expect(resp(set).args.newState).not.toBe(emailState);

    const after = await inboxState(app, accountId, inbox);
    expect(after.list[0]).toMatchObject({ totalEmails: 2, unreadEmails: 1, unreadThreads: 1 });

    const changes = await call(app, [["Mailbox/changes", { accountId, sinceState: mbState }, "c"]]);
    expect(resp(changes).args).toMatchObject({
      created: [],
      updated: [inbox],
      destroyed: [],
      hasMoreChanges: false,
      updatedProperties: ["totalEmails", "unreadEmails", "totalThreads", "unreadThreads"],
    });
    expect(resp(changes).args.newState).toBe(after.state);

    // no-op patch does not bump the state
    const again = await call(app, [
      ["Email/set", { accountId, update: { [e1]: { "keywords/$seen": true } } }, "s"],
    ]);
    expect(resp(again).args.oldState).toBe(resp(again).args.newState);

    // un-seen it again, with a whole-keywords replacement
    await call(app, [
      ["Email/set", { accountId, update: { [e1]: { keywords: { $flagged: true } } } }, "s"],
    ]);
    const g = await call(app, [
      ["Email/get", { accountId, ids: [e1], properties: ["keywords"] }, "g"],
    ]);
    expect(resp(g).args.list[0].keywords).toEqual({ $flagged: true });
    const unread = await inboxState(app, accountId, inbox);
    expect(unread.list[0].unreadEmails).toBe(2);
  });
});
