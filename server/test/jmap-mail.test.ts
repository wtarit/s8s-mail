import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { accountStub } from "../src/store/subscribe";
import { call, deliver, resp, setupAccount } from "./helpers/jmap";


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
      ["Thread/get", { accountId, "#ids": { resultOf: "g", name: "Email/get", path: "/list/*/threadId" } }, "t"],
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
        { accountId, ids: [first.id], properties: ["bodyValues"], fetchTextBodyValues: true, maxBodyValueBytes: 5 },
        "g",
      ],
    ]);
    expect(resp(trunc).args.list[0].bodyValues[partId]).toMatchObject({ value: "Hello", isTruncated: true });
  });

  it("$seen patch moves unread counts and shows up in Mailbox/changes (counts only)", async () => {
    const { app, accountId, box } = await setupAccount("jm-2", ["jm-2@example.com"]);
    const inbox = box("inbox");
    await deliver(accountId, `${accountId}@example.com`, { subject: "One", messageId: "<s1@example.com>" });
    await deliver(accountId, `${accountId}@example.com`, { subject: "Two", messageId: "<s2@example.com>" });
    const before = await call(app, [
      ["Mailbox/get", { accountId, ids: [inbox] }, "m"],
      ["Email/query", { accountId }, "q"],
    ]);
    const mbState = resp(before, 0).args.state;
    const [e1] = resp(before, 1).args.ids;
    const emailState = (await call(app, [["Email/get", { accountId, ids: [e1], properties: ["id"] }, "g"]]))
      .methodResponses[0]![1].state;

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
    await call(app, [["Email/set", { accountId, update: { [e1]: { keywords: { "$flagged": true } } } }, "s"]]);
    const g = await call(app, [["Email/get", { accountId, ids: [e1], properties: ["keywords"] }, "g"]]);
    expect(resp(g).args.list[0].keywords).toEqual({ "$flagged": true });
    const unread = await inboxState(app, accountId, inbox);
    expect(unread.list[0].unreadEmails).toBe(2);
  });

  it("Email/changes collapses per object (delivery = created) and reports destroyed", async () => {
    const { app, accountId, box } = await setupAccount("jm-3", ["jm-3@example.com"]);
    const state0 = (await call(app, [["Email/get", { accountId, ids: [] }, "g"]])).methodResponses[0]![1].state;
    await deliver(accountId, `${accountId}@example.com`, { subject: "A", messageId: "<c1@example.com>" });
    await deliver(accountId, `${accountId}@example.com`, { subject: "B", messageId: "<c2@example.com>" });
    const q = await call(app, [["Email/query", { accountId }, "q"]]);
    const ids: string[] = resp(q).args.ids;
    const ch = await call(app, [["Email/changes", { accountId, sinceState: state0 }, "c"]]);
    expect(resp(ch).args.created.toSorted()).toEqual(ids.toSorted());
    expect(resp(ch).args.updated).toEqual([]);
    expect(resp(ch).args.destroyed).toEqual([]);
    const mid = resp(ch).args.newState;

    await call(app, [["Email/set", { accountId, update: { [ids[0]!]: { [`mailboxIds/${box("trash")}`]: true } } }, "s"]]);
    await call(app, [["Email/set", { accountId, destroy: [ids[1]!] }, "d"]]);
    const ch2 = await call(app, [["Email/changes", { accountId, sinceState: mid }, "c"]]);
    expect(resp(ch2).args).toMatchObject({ created: [], updated: [ids[0]], destroyed: [ids[1]] });

    // created then destroyed inside one window disappears
    const ch3 = await call(app, [["Email/changes", { accountId, sinceState: state0 }, "c"]]);
    expect(resp(ch3).args.created).toEqual([ids[0]]);
    expect(resp(ch3).args.destroyed).toEqual([]);

    const bad = await call(app, [["Email/changes", { accountId, sinceState: "999999" }, "c"]]);
    expect(resp(bad).args.type).toBe("cannotCalculateChanges");
    const maxed = await call(app, [["Email/changes", { accountId, sinceState: state0, maxChanges: 1 }, "c"]]);
    expect(resp(maxed).args.hasMoreChanges).toBe(true);
    expect(resp(maxed).args.created).toHaveLength(1);
  });

  it("serves bodies of unparsed (pending) messages through the on-demand fallback", async () => {
    const { app, accountId } = await setupAccount("jm-4", ["jm-4@example.com"]);
    await deliver(accountId, `${accountId}@example.com`, { subject: "Pending", text: "not yet parsed body" });
    const q = await call(app, [["Email/query", { accountId }, "q"]]);
    const id = resp(q).args.ids[0];
    // Put the row back into the state ingest leaves it in (the alarm races the test otherwise).
    await runInDurableObject(accountStub(env, accountId), (_i, state) => {
      state.storage.sql.exec(
        "UPDATE email SET parse_state = 'pending', preview = '', has_attachment = 0, body_structure = NULL, text_body = NULL, html_body = NULL, attachments = NULL",
      );
    });
    const g = await call(app, [
      [
        "Email/get",
        { accountId, ids: [id], properties: ["subject", "preview", "textBody", "bodyValues"], fetchTextBodyValues: true },
        "g",
      ],
    ]);
    const e = resp(g).args.list[0];
    expect(e.subject).toBe("Pending");
    expect(Object.values(e.bodyValues)[0]).toMatchObject({ value: "not yet parsed body\n" });
    // list properties only: no body work, empty preview until the alarm ran
    const light = await call(app, [["Email/get", { accountId, ids: [id], properties: ["preview"] }, "g"]]);
    expect(resp(light).args.list[0].preview).toBe("");
  });

  it("supports header:* forms and headers", async () => {
    const { app, accountId } = await setupAccount("jm-5", ["jm-5@example.com"]);
    await deliver(accountId, `${accountId}@example.com`, { subject: "Hdr", messageId: "<h1@example.com>" });
    const id = resp(await call(app, [["Email/query", { accountId }, "q"]])).args.ids[0];
    const g = await call(app, [
      [
        "Email/get",
        {
          accountId,
          ids: [id],
          properties: ["header:Subject:asText", "header:Message-ID:asMessageIds", "header:From:asAddresses", "header:X-Nope", "header:Date:asDate", "headers"],
        },
        "g",
      ],
    ]);
    const e = resp(g).args.list[0];
    expect(e["header:Subject:asText"]).toBe("Hdr");
    expect(e["header:Message-ID:asMessageIds"]).toEqual(["h1@example.com"]);
    expect(e["header:From:asAddresses"]).toEqual([{ name: "Bob", email: "bob@example.com" }]);
    expect(e["header:X-Nope"]).toBeNull();
    expect(e["header:Date:asDate"]).toBe("2026-10-12T03:00:00Z");
    expect(e.headers.find((h: any) => h.name === "Subject")).toEqual({ name: "Subject", value: " Hdr" });
    const bad = await call(app, [["Email/get", { accountId, ids: [id], properties: ["nonsense"] }, "g"]]);
    expect(resp(bad).args.type).toBe("invalidArguments");
  });
});

describe("Email/query filters and sorts", () => {
  it("filters on keywords, size, dates, addresses, text and operators; sorts; pages", async () => {
    const { app, accountId, box } = await setupAccount("jm-6", ["jm-6@example.com"]);
    await deliver(accountId, `${accountId}@example.com`, { subject: "Alpha invoice", from: "Zed <zed@example.com>", messageId: "<q1@example.com>", text: "pay the invoice soon", date: "Mon, 12 Oct 2026 10:00:00 +0000" });
    await deliver(accountId, `${accountId}@example.com`, { subject: "Beta meeting", from: "Amy <amy@example.com>", messageId: "<q2@example.com>", text: "see you at noon", date: "Mon, 12 Oct 2026 11:00:00 +0000" });
    await deliver(accountId, `${accountId}@example.com`, { subject: "Gamma attachment", from: "Bob <bob@example.com>", messageId: "<q3@example.com>", text: "file attached", date: "Mon, 12 Oct 2026 12:00:00 +0000", attachment: { filename: "a.txt", mimeType: "text/plain", base64: "aGVsbG8=" } });
    const all = resp(await call(app, [["Email/query", { accountId, sort: [{ property: "subject" }] }, "q"]])).args.ids as string[];
    const subj = async (filter: unknown, extra: Record<string, unknown> = {}) => {
      const q = await call(app, [
        ["Email/query", { accountId, filter, sort: [{ property: "subject", isAscending: true }], ...extra }, "q"],
        ["Email/get", { accountId, "#ids": { resultOf: "q", name: "Email/query", path: "/ids" }, properties: ["subject"] }, "g"],
      ]);
      if (resp(q).name === "error") return resp(q).args.type;
      const byId = new Map(resp(q, 1).args.list.map((e: any) => [e.id, e.subject]));
      return resp(q).args.ids.map((i: string) => byId.get(i));
    };
    await call(app, [["Email/set", { accountId, update: { [all[0]!]: { "keywords/$flagged": true, "keywords/$seen": true } } }, "s"]]);

    expect(await subj({ hasKeyword: "$flagged" })).toEqual(["Alpha invoice"]);
    expect(await subj({ notKeyword: "$seen" })).toEqual(["Beta meeting", "Gamma attachment"]);
    expect(await subj({ hasAttachment: true })).toEqual(["Gamma attachment"]);
    expect(await subj({ from: "amy" })).toEqual(["Beta meeting"]);
    expect(await subj({ subject: "MEETING" })).toEqual(["Beta meeting"]);
    expect(await subj({ text: "invoice" })).toEqual(["Alpha invoice"]);
    expect(await subj({ body: "noon" })).toEqual(["Beta meeting"]);
    expect(await subj({ text: "inv*" })).toEqual(["Alpha invoice"]);
    expect(await subj({ after: "2026-01-01T00:00:00Z" })).toHaveLength(3);
    expect(await subj({ before: "2026-01-01T00:00:00Z" })).toEqual([]);
    expect(await subj({ operator: "OR", conditions: [{ from: "zed" }, { subject: "gamma" }] })).toEqual(["Alpha invoice", "Gamma attachment"]);
    expect(await subj({ operator: "NOT", conditions: [{ hasKeyword: "$seen" }] })).toEqual(["Beta meeting", "Gamma attachment"]);
    expect(await subj({ operator: "AND", conditions: [{ notKeyword: "$seen" }, { text: "attached" }] })).toEqual(["Gamma attachment"]);
    expect(await subj({ inMailboxOtherThan: [box("inbox")] })).toEqual([]);
    expect(await subj({ inMailbox: box("trash") })).toEqual([]);
    expect(await subj({ minSize: 1, maxSize: 100000000 })).toHaveLength(3);
    expect(await subj({ someInThreadHaveKeyword: "$flagged" })).toEqual(["Alpha invoice"]);
    expect(await subj({ noneInThreadHaveKeyword: "$flagged" })).toEqual(["Beta meeting", "Gamma attachment"]);
    expect(await subj({ allInThreadHaveKeyword: "$flagged" })).toEqual(["Alpha invoice"]);
    expect(await subj({ header: ["Subject", "beta"] })).toEqual(["Beta meeting"]);
    expect(await subj({ bogus: 1 })).toBe("unsupportedFilter");
    expect(await subj({ before: "not a date" })).toBe("invalidArguments");

    // sorts
    const sorted = async (sort: unknown[]) => {
      const q = await call(app, [
        ["Email/query", { accountId, sort }, "q"],
        ["Email/get", { accountId, "#ids": { resultOf: "q", name: "Email/query", path: "/ids" }, properties: ["subject"] }, "g"],
      ]);
      const byId = new Map(resp(q, 1).args.list.map((e: any) => [e.id, e.subject]));
      return resp(q).args.ids.map((i: string) => byId.get(i));
    };
    expect(await sorted([{ property: "from", isAscending: true }])).toEqual(["Beta meeting", "Gamma attachment", "Alpha invoice"]);
    expect(await sorted([{ property: "receivedAt", isAscending: false }, { property: "subject" }]).then((x) => x.length)).toBe(3);
    expect(await sorted([{ property: "subject", isAscending: false }])).toEqual(["Gamma attachment", "Beta meeting", "Alpha invoice"]);
    expect(await sorted([{ property: "hasKeyword", keyword: "$flagged", isAscending: false }, { property: "subject" }])).toEqual(["Alpha invoice", "Beta meeting", "Gamma attachment"]);
    expect(await sorted([{ property: "size", isAscending: true }]).then((x) => x.length)).toBe(3);
    const unsupported = await call(app, [["Email/query", { accountId, sort: [{ property: "nope" }] }, "q"]]);
    expect(resp(unsupported).args.type).toBe("unsupportedSort");

    // paging
    const page = await call(app, [
      ["Email/query", { accountId, sort: [{ property: "subject" }], position: 1, limit: 1, calculateTotal: true }, "q"],
      ["Email/query", { accountId, sort: [{ property: "subject" }], anchor: all[1], anchorOffset: 1, limit: 5 }, "q2"],
      ["Email/query", { accountId, sort: [{ property: "subject" }], anchor: "nope" }, "q3"],
      ["Email/query", { accountId, sort: [{ property: "subject" }], position: -1 }, "q4"],
      ["Email/query", { accountId, limit: 0, calculateTotal: true }, "q5"],
    ]);
    expect(resp(page, 0).args).toMatchObject({ ids: [all[1]], position: 1, total: 3 });
    expect(resp(page, 1).args).toMatchObject({ ids: [all[2]], position: 2 });
    expect(resp(page, 2).args.type).toBe("anchorNotFound");
    expect(resp(page, 3).args.ids).toEqual([all[2]]);
    expect(resp(page, 4).args).toMatchObject({ ids: [], total: 3 });
  });

  it("SearchSnippet/get highlights terms", async () => {
    const { app, accountId } = await setupAccount("jm-7", ["jm-7@example.com"]);
    await deliver(accountId, `${accountId}@example.com`, { subject: "Pineapple pizza <b>", text: "I really love pineapple & ham on pizza." });
    const filter = { text: "pineapple" };
    const r = await call(app, [
      ["Email/query", { accountId, filter }, "q"],
      ["SearchSnippet/get", { accountId, filter, "#emailIds": { resultOf: "q", name: "Email/query", path: "/ids" } }, "s"],
    ]);
    const snip = resp(r, 1).args.list[0];
    expect(snip.subject).toBe("<mark>Pineapple</mark> pizza &lt;b&gt;");
    expect(snip.preview).toContain("<mark>pineapple</mark>");
    expect(snip.preview).toContain("&amp;");
  });
});

describe("Mailbox/set", () => {
  it("creates, updates, nests and destroys with the RFC error types", async () => {
    const { app, accountId, box } = await setupAccount("jm-8", ["jm-8@example.com"]);
    await deliver(accountId, `${accountId}@example.com`, { subject: "In inbox" });
    const r = await call(app, [
      ["Mailbox/set", { accountId, create: { a: { name: "Work" }, b: { name: "work" }, c: { name: "" }, d: { name: "X", role: "inbox" }, e: { name: "Y", foo: 1 } } }, "s"],
    ]);
    const a = resp(r).args;
    expect(a.created.a.id).toBeTruthy();
    expect(a.notCreated.b.type).toBe("invalidProperties");
    expect(a.notCreated.c.properties).toEqual(["name"]);
    expect(a.notCreated.d.properties).toEqual(["role"]);
    expect(a.notCreated.e.type).toBe("invalidProperties");
    const work = a.created.a.id;

    const u = await call(app, [
      ["Mailbox/set", { accountId, update: { [work]: { name: "Jobs", sortOrder: 50 }, [box("sent")]: { role: null }, [box("inbox")]: { parentId: work }, nope: { name: "q" } } }, "s"],
    ]);
    expect(resp(u).args.updated).toHaveProperty(work);
    expect(resp(u).args.notUpdated[box("sent")].type).toBe("forbidden");
    expect(resp(u).args.notUpdated.nope.type).toBe("notFound");
    // inbox moved under Jobs, then Jobs cannot move under inbox
    const loop = await call(app, [["Mailbox/set", { accountId, update: { [work]: { parentId: box("inbox") } } }, "s"]]);
    expect(resp(loop).args.notUpdated[work].type).toBe("invalidProperties");

    await call(app, [["Mailbox/set", { accountId, update: { [box("inbox")]: { parentId: null } } }, "s"]]);
    const q = await call(app, [["Mailbox/query", { accountId, filter: { name: "job" } }, "q"]]);
    expect(resp(q).args.ids).toEqual([work]);

    // destroy rules
    const sub = (await call(app, [["Mailbox/set", { accountId, create: { s: { name: "Sub", parentId: work } } }, "s"]])).methodResponses[0]![1].created.s.id;
    const d1 = await call(app, [["Mailbox/set", { accountId, destroy: [work, box("trash"), "ghost"] }, "s"]]);
    expect(resp(d1).args.notDestroyed[work].type).toBe("mailboxHasChild");
    expect(resp(d1).args.notDestroyed[box("trash")].type).toBe("forbidden");
    expect(resp(d1).args.notDestroyed.ghost.type).toBe("notFound");

    const em = resp(await call(app, [["Email/query", { accountId }, "q"]])).args.ids[0];
    await call(app, [["Email/set", { accountId, update: { [em]: { mailboxIds: { [sub]: true } } } }, "u"]]);
    const d2 = await call(app, [["Mailbox/set", { accountId, destroy: [sub] }, "s"]]);
    expect(resp(d2).args.notDestroyed[sub].type).toBe("mailboxHasEmail");
    const d3 = await call(app, [["Mailbox/set", { accountId, destroy: [sub], onDestroyRemoveEmails: true }, "s"]]);
    expect(resp(d3).args.destroyed).toEqual([sub]);
    const gone = await call(app, [["Email/get", { accountId, ids: [em] }, "g"]]);
    expect(resp(gone).args.notFound).toEqual([em]);
    const d4 = await call(app, [["Mailbox/set", { accountId, destroy: [work] }, "s"]]);
    expect(resp(d4).args.destroyed).toEqual([work]);
  });

  it("rejects stale ifInState and reports queryChanges as unsupported", async () => {
    const { app, accountId } = await setupAccount("jm-9", ["jm-9@example.com"]);
    const r = await call(app, [
      ["Mailbox/set", { accountId, ifInState: "9999", create: { a: { name: "X" } } }, "s"],
      ["Mailbox/queryChanges", { accountId, sinceQueryState: "0" }, "qc"],
      ["Email/queryChanges", { accountId, sinceQueryState: "0" }, "qc2"],
    ]);
    expect(resp(r, 0).args.type).toBe("stateMismatch");
    expect(resp(r, 1).args.type).toBe("cannotCalculateChanges");
    expect(resp(r, 2).args.type).toBe("cannotCalculateChanges");
  });
});
