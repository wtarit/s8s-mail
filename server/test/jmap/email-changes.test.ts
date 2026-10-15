/* oxlint-disable typescript/no-explicit-any -- JSON responses are read untyped in tests */
import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { accountStub } from "../../src/store/subscribe";
import { call, deliver, resp, setupAccount } from "../helpers/jmap";

describe("mailboxes, emails and counts", () => {
  it("Email/changes collapses per object (delivery = created) and reports destroyed", async () => {
    const { app, accountId, box } = await setupAccount("jm-3", ["jm-3@example.com"]);
    const state0 = (await call(app, [["Email/get", { accountId, ids: [] }, "g"]]))
      .methodResponses[0]![1].state;
    await deliver(accountId, `${accountId}@example.com`, {
      subject: "A",
      messageId: "<c1@example.com>",
    });
    await deliver(accountId, `${accountId}@example.com`, {
      subject: "B",
      messageId: "<c2@example.com>",
    });
    const q = await call(app, [["Email/query", { accountId }, "q"]]);
    const ids: string[] = resp(q).args.ids;
    const ch = await call(app, [["Email/changes", { accountId, sinceState: state0 }, "c"]]);
    expect(resp(ch).args.created.toSorted()).toEqual(ids.toSorted());
    expect(resp(ch).args.updated).toEqual([]);
    expect(resp(ch).args.destroyed).toEqual([]);
    const mid = resp(ch).args.newState;

    await call(app, [
      [
        "Email/set",
        { accountId, update: { [ids[0]!]: { [`mailboxIds/${box("trash")}`]: true } } },
        "s",
      ],
    ]);
    await call(app, [["Email/set", { accountId, destroy: [ids[1]!] }, "d"]]);
    const ch2 = await call(app, [["Email/changes", { accountId, sinceState: mid }, "c"]]);
    expect(resp(ch2).args).toMatchObject({ created: [], updated: [ids[0]], destroyed: [ids[1]] });

    // created then destroyed inside one window disappears
    const ch3 = await call(app, [["Email/changes", { accountId, sinceState: state0 }, "c"]]);
    expect(resp(ch3).args.created).toEqual([ids[0]]);
    expect(resp(ch3).args.destroyed).toEqual([]);

    const bad = await call(app, [["Email/changes", { accountId, sinceState: "999999" }, "c"]]);
    expect(resp(bad).args.type).toBe("cannotCalculateChanges");
    const maxed = await call(app, [
      ["Email/changes", { accountId, sinceState: state0, maxChanges: 1 }, "c"],
    ]);
    expect(resp(maxed).args.hasMoreChanges).toBe(true);
    expect(resp(maxed).args.created).toHaveLength(1);
  });

  it("serves bodies of unparsed (pending) messages through the on-demand fallback", async () => {
    const { app, accountId } = await setupAccount("jm-4", ["jm-4@example.com"]);
    await deliver(accountId, `${accountId}@example.com`, {
      subject: "Pending",
      text: "not yet parsed body",
    });
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
        {
          accountId,
          ids: [id],
          properties: ["subject", "preview", "textBody", "bodyValues"],
          fetchTextBodyValues: true,
        },
        "g",
      ],
    ]);
    const e = resp(g).args.list[0];
    expect(e.subject).toBe("Pending");
    expect(Object.values(e.bodyValues)[0]).toMatchObject({ value: "not yet parsed body\n" });
    // list properties only: no body work, empty preview until the alarm ran
    const light = await call(app, [
      ["Email/get", { accountId, ids: [id], properties: ["preview"] }, "g"],
    ]);
    expect(resp(light).args.list[0].preview).toBe("");
  });

  it("supports header:* forms and headers", async () => {
    const { app, accountId } = await setupAccount("jm-5", ["jm-5@example.com"]);
    await deliver(accountId, `${accountId}@example.com`, {
      subject: "Hdr",
      messageId: "<h1@example.com>",
    });
    const id = resp(await call(app, [["Email/query", { accountId }, "q"]])).args.ids[0];
    const g = await call(app, [
      [
        "Email/get",
        {
          accountId,
          ids: [id],
          properties: [
            "header:Subject:asText",
            "header:Message-ID:asMessageIds",
            "header:From:asAddresses",
            "header:X-Nope",
            "header:Date:asDate",
            "headers",
          ],
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
    expect(e.headers.find((h: any) => h.name === "Subject")).toEqual({
      name: "Subject",
      value: " Hdr",
    });
    const bad = await call(app, [
      ["Email/get", { accountId, ids: [id], properties: ["nonsense"] }, "g"],
    ]);
    expect(resp(bad).args.type).toBe("invalidArguments");
  });
});
