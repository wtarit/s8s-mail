/* oxlint-disable typescript/no-explicit-any -- JSON responses are read untyped in tests */
import { describe, expect, it } from "vitest";
import { call, resp, setupAccount } from "../helpers/jmap";
import { installMailgunFetchMock } from "../helpers/jmap-send";

installMailgunFetchMock();

describe("Identity/set", () => {
  it("updates name and signatures, forbids create and destroy", async () => {
    const { app, accountId } = await setupAccount("idn-1", [
      "idn-1@example.com",
      "alias-idn@example.com",
    ]);
    const first = resp(await call(app, [["Identity/get", { accountId }, "g"]]));
    const [id1, id2] = first.args.list.map((i: any) => i.id);
    expect(id1).toMatch(/^[A-Za-z0-9_-]{1,255}$/);
    const r = await call(app, [
      [
        "Identity/set",
        {
          accountId,
          create: { n: { name: "New", email: "other@example.com" } },
          update: {
            [id1]: {
              name: "Ana B",
              textSignature: "-- \nAna",
              htmlSignature: "<b>Ana</b>",
              replyTo: [{ email: "reply@example.net" }],
            },
            [id2]: { email: "x@example.com" },
            nope: { name: "x" },
          },
          destroy: [id2],
        },
        "s",
      ],
      ["Identity/get", { accountId, ids: [id1] }, "g2"],
      ["Identity/changes", { accountId, sinceState: "0" }, "c"],
    ]);
    const s = resp(r).args;
    expect(s.notCreated.n.type).toBe("forbidden");
    expect(s.notDestroyed[id2].type).toBe("forbidden");
    expect(s.updated).toHaveProperty(id1);
    expect(s.notUpdated[id2].type).toBe("invalidProperties");
    expect(s.notUpdated.nope.type).toBe("notFound");
    expect(s.oldState).not.toBe(s.newState);
    expect(resp(r, 1).args.list[0]).toMatchObject({
      name: "Ana B",
      textSignature: "-- \nAna",
      htmlSignature: "<b>Ana</b>",
      replyTo: [{ name: null, email: "reply@example.net" }],
    });
    expect(resp(r, 2).args.type).toBe("cannotCalculateChanges");
  });
});
