/* oxlint-disable typescript/no-explicit-any -- JSON responses are read untyped in tests */
import { describe, expect, it } from "vitest";
import { call, deliver, resp, setupAccount } from "../helpers/jmap";

describe("Email/query filters and sorts", () => {
  it("filters on keywords, size, dates, addresses, text and operators; sorts; pages", async () => {
    const { app, accountId, box } = await setupAccount("jm-6", ["jm-6@example.com"]);
    await deliver(accountId, `${accountId}@example.com`, {
      subject: "Alpha invoice",
      from: "Zed <zed@example.com>",
      messageId: "<q1@example.com>",
      text: "pay the invoice soon",
      date: "Mon, 12 Oct 2026 10:00:00 +0000",
    });
    await deliver(accountId, `${accountId}@example.com`, {
      subject: "Beta meeting",
      from: "Amy <amy@example.com>",
      messageId: "<q2@example.com>",
      text: "see you at noon",
      date: "Mon, 12 Oct 2026 11:00:00 +0000",
    });
    await deliver(accountId, `${accountId}@example.com`, {
      subject: "Gamma attachment",
      from: "Bob <bob@example.com>",
      messageId: "<q3@example.com>",
      text: "file attached",
      date: "Mon, 12 Oct 2026 12:00:00 +0000",
      attachment: { filename: "a.txt", mimeType: "text/plain", base64: "aGVsbG8=" },
    });
    const all = resp(
      await call(app, [["Email/query", { accountId, sort: [{ property: "subject" }] }, "q"]]),
    ).args.ids as string[];
    const subj = async (filter: unknown, extra: Record<string, unknown> = {}) => {
      const q = await call(app, [
        [
          "Email/query",
          { accountId, filter, sort: [{ property: "subject", isAscending: true }], ...extra },
          "q",
        ],
        [
          "Email/get",
          {
            accountId,
            "#ids": { resultOf: "q", name: "Email/query", path: "/ids" },
            properties: ["subject"],
          },
          "g",
        ],
      ]);
      if (resp(q).name === "error") return resp(q).args.type;
      const byId = new Map(resp(q, 1).args.list.map((e: any) => [e.id, e.subject]));
      return resp(q).args.ids.map((i: string) => byId.get(i));
    };
    await call(app, [
      [
        "Email/set",
        { accountId, update: { [all[0]!]: { "keywords/$flagged": true, "keywords/$seen": true } } },
        "s",
      ],
    ]);

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
    expect(
      await subj({ operator: "OR", conditions: [{ from: "zed" }, { subject: "gamma" }] }),
    ).toEqual(["Alpha invoice", "Gamma attachment"]);
    expect(await subj({ operator: "NOT", conditions: [{ hasKeyword: "$seen" }] })).toEqual([
      "Beta meeting",
      "Gamma attachment",
    ]);
    expect(
      await subj({ operator: "AND", conditions: [{ notKeyword: "$seen" }, { text: "attached" }] }),
    ).toEqual(["Gamma attachment"]);
    expect(await subj({ inMailboxOtherThan: [box("inbox")] })).toEqual([]);
    expect(await subj({ inMailbox: box("trash") })).toEqual([]);
    expect(await subj({ minSize: 1, maxSize: 100000000 })).toHaveLength(3);
    expect(await subj({ someInThreadHaveKeyword: "$flagged" })).toEqual(["Alpha invoice"]);
    expect(await subj({ noneInThreadHaveKeyword: "$flagged" })).toEqual([
      "Beta meeting",
      "Gamma attachment",
    ]);
    expect(await subj({ allInThreadHaveKeyword: "$flagged" })).toEqual(["Alpha invoice"]);
    expect(await subj({ header: ["Subject", "beta"] })).toEqual(["Beta meeting"]);
    expect(await subj({ bogus: 1 })).toBe("unsupportedFilter");
    expect(await subj({ before: "not a date" })).toBe("invalidArguments");

    // sorts
    const sorted = async (sort: unknown[]) => {
      const q = await call(app, [
        ["Email/query", { accountId, sort }, "q"],
        [
          "Email/get",
          {
            accountId,
            "#ids": { resultOf: "q", name: "Email/query", path: "/ids" },
            properties: ["subject"],
          },
          "g",
        ],
      ]);
      const byId = new Map(resp(q, 1).args.list.map((e: any) => [e.id, e.subject]));
      return resp(q).args.ids.map((i: string) => byId.get(i));
    };
    expect(await sorted([{ property: "from", isAscending: true }])).toEqual([
      "Beta meeting",
      "Gamma attachment",
      "Alpha invoice",
    ]);
    expect(
      await sorted([{ property: "receivedAt", isAscending: false }, { property: "subject" }]).then(
        (x) => x.length,
      ),
    ).toBe(3);
    expect(await sorted([{ property: "subject", isAscending: false }])).toEqual([
      "Gamma attachment",
      "Beta meeting",
      "Alpha invoice",
    ]);
    expect(
      await sorted([
        { property: "hasKeyword", keyword: "$flagged", isAscending: false },
        { property: "subject" },
      ]),
    ).toEqual(["Alpha invoice", "Beta meeting", "Gamma attachment"]);
    expect(await sorted([{ property: "size", isAscending: true }]).then((x) => x.length)).toBe(3);
    const unsupported = await call(app, [
      ["Email/query", { accountId, sort: [{ property: "nope" }] }, "q"],
    ]);
    expect(resp(unsupported).args.type).toBe("unsupportedSort");

    // paging
    const page = await call(app, [
      [
        "Email/query",
        { accountId, sort: [{ property: "subject" }], position: 1, limit: 1, calculateTotal: true },
        "q",
      ],
      [
        "Email/query",
        { accountId, sort: [{ property: "subject" }], anchor: all[1], anchorOffset: 1, limit: 5 },
        "q2",
      ],
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
    await deliver(accountId, `${accountId}@example.com`, {
      subject: "Pineapple pizza <b>",
      text: "I really love pineapple & ham on pizza.",
    });
    const filter = { text: "pineapple" };
    const r = await call(app, [
      ["Email/query", { accountId, filter }, "q"],
      [
        "SearchSnippet/get",
        { accountId, filter, "#emailIds": { resultOf: "q", name: "Email/query", path: "/ids" } },
        "s",
      ],
    ]);
    const snip = resp(r, 1).args.list[0];
    expect(snip.subject).toBe("<mark>Pineapple</mark> pizza &lt;b&gt;");
    expect(snip.preview).toContain("<mark>pineapple</mark>");
    expect(snip.preview).toContain("&amp;");
  });
});
