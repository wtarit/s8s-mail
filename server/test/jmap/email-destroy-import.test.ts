/* oxlint-disable typescript/no-explicit-any -- JSON responses are read untyped in tests */
import { env } from "cloudflare:workers";
import { runDurableObjectAlarm } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { accountStub } from "../../src/store/subscribe";
import { call, resp, setupAccount } from "../helpers/jmap";
import { bytes, installMailgunFetchMock, upload } from "../helpers/jmap-send";

installMailgunFetchMock();

describe("drafts and sending", () => {
  it("destroys emails and removes their blobs; imports an uploaded message", async () => {
    const { app, accountId, box } = await setupAccount("snd-4", ["snd-4@example.com"]);
    const raw =
      "From: Bob <bob@example.com>\r\nTo: snd-4@example.com\r\nSubject: Imported\r\nMessage-ID: <imp1@example.com>\r\nDate: Mon, 12 Oct 2026 10:00:00 +0000\r\n\r\nImported body\r\n";
    const up = await upload(app, accountId, bytes(raw), "message/rfc822");
    const imp = await call(app, [
      [
        "Email/import",
        {
          accountId,
          emails: {
            i1: {
              blobId: up.json.blobId,
              mailboxIds: { [box("inbox")]: true },
              keywords: { $seen: true },
            },
          },
        },
        "i",
      ],
      [
        "Email/import",
        { accountId, emails: { i2: { blobId: "Umissing", mailboxIds: { [box("inbox")]: true } } } },
        "i2",
      ],
    ]);
    const created = resp(imp).args.created.i1;
    expect(created.blobId).not.toBe(up.json.blobId);
    expect(resp(imp, 1).args.notCreated.i2.type).toBe("blobNotFound");
    await runDurableObjectAlarm(accountStub(env, accountId));
    const g = await call(app, [
      [
        "Email/get",
        {
          accountId,
          ids: [created.id],
          properties: ["subject", "keywords", "from", "preview", "sentAt"],
        },
        "g",
      ],
    ]);
    expect(resp(g).args.list[0]).toMatchObject({
      subject: "Imported",
      keywords: { $seen: true },
      from: [{ name: "Bob", email: "bob@example.com" }],
      preview: "Imported body",
    });

    expect(await env.BLOBS.head(`snd-4/${created.blobId}`)).not.toBeNull();
    expect(await env.BLOBS.head(`snd-4/${created.blobId}-1`)).not.toBeNull();
    const d = await call(app, [["Email/set", { accountId, destroy: [created.id, "ghost"] }, "d"]]);
    expect(resp(d).args.destroyed).toEqual([created.id]);
    expect(resp(d).args.notDestroyed.ghost.type).toBe("notFound");
    expect(await env.BLOBS.head(`snd-4/${created.blobId}`)).toBeNull();
    expect(await env.BLOBS.head(`snd-4/${created.blobId}-1`)).toBeNull();
  });
});
