/* oxlint-disable typescript/no-explicit-any -- JSON responses are read untyped in tests */
import { describe, expect, it } from "vitest";
import { call, deliver, resp, setupAccount } from "../helpers/jmap";

describe("Mailbox/set", () => {
  it("creates, updates, nests and destroys with the RFC error types", async () => {
    const { app, accountId, box } = await setupAccount("jm-8", ["jm-8@example.com"]);
    await deliver(accountId, `${accountId}@example.com`, { subject: "In inbox" });
    const r = await call(app, [
      [
        "Mailbox/set",
        {
          accountId,
          create: {
            a: { name: "Work" },
            b: { name: "work" },
            c: { name: "" },
            d: { name: "X", role: "inbox" },
            e: { name: "Y", foo: 1 },
          },
        },
        "s",
      ],
    ]);
    const a = resp(r).args;
    expect(a.created.a.id).toBeTruthy();
    expect(a.notCreated.b.type).toBe("invalidProperties");
    expect(a.notCreated.c.properties).toEqual(["name"]);
    expect(a.notCreated.d.properties).toEqual(["role"]);
    expect(a.notCreated.e.type).toBe("invalidProperties");
    const work = a.created.a.id;

    const u = await call(app, [
      [
        "Mailbox/set",
        {
          accountId,
          update: {
            [work]: { name: "Jobs", sortOrder: 50 },
            [box("sent")]: { role: null },
            [box("inbox")]: { parentId: work },
            nope: { name: "q" },
          },
        },
        "s",
      ],
    ]);
    expect(resp(u).args.updated).toHaveProperty(work);
    expect(resp(u).args.notUpdated[box("sent")].type).toBe("forbidden");
    expect(resp(u).args.notUpdated.nope.type).toBe("notFound");
    // inbox moved under Jobs, then Jobs cannot move under inbox
    const loop = await call(app, [
      ["Mailbox/set", { accountId, update: { [work]: { parentId: box("inbox") } } }, "s"],
    ]);
    expect(resp(loop).args.notUpdated[work].type).toBe("invalidProperties");

    await call(app, [
      ["Mailbox/set", { accountId, update: { [box("inbox")]: { parentId: null } } }, "s"],
    ]);
    const q = await call(app, [["Mailbox/query", { accountId, filter: { name: "job" } }, "q"]]);
    expect(resp(q).args.ids).toEqual([work]);

    // destroy rules
    const sub = (
      await call(app, [
        ["Mailbox/set", { accountId, create: { s: { name: "Sub", parentId: work } } }, "s"],
      ])
    ).methodResponses[0]![1].created.s.id;
    const d1 = await call(app, [
      ["Mailbox/set", { accountId, destroy: [work, box("trash"), "ghost"] }, "s"],
    ]);
    expect(resp(d1).args.notDestroyed[work].type).toBe("mailboxHasChild");
    expect(resp(d1).args.notDestroyed[box("trash")].type).toBe("forbidden");
    expect(resp(d1).args.notDestroyed.ghost.type).toBe("notFound");

    const em = resp(await call(app, [["Email/query", { accountId }, "q"]])).args.ids[0];
    await call(app, [
      ["Email/set", { accountId, update: { [em]: { mailboxIds: { [sub]: true } } } }, "u"],
    ]);
    const d2 = await call(app, [["Mailbox/set", { accountId, destroy: [sub] }, "s"]]);
    expect(resp(d2).args.notDestroyed[sub].type).toBe("mailboxHasEmail");
    const d3 = await call(app, [
      ["Mailbox/set", { accountId, destroy: [sub], onDestroyRemoveEmails: true }, "s"],
    ]);
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
