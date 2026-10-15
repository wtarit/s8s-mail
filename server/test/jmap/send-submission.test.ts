/* oxlint-disable typescript/no-explicit-any -- JSON responses are read untyped in tests */
import { env } from "cloudflare:workers";
import { runDurableObjectAlarm } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { accountStub } from "../../src/store/subscribe";
import { call, resp, setupAccount } from "../helpers/jmap";
import { bytes, fetchSpy, installMailgunFetchMock, upload } from "../helpers/jmap-send";

installMailgunFetchMock();

describe("drafts and sending", () => {
  it("creates a draft with an attachment, submits it via Mailgun without Bcc, moves it to Sent", async () => {
    const { app, accountId, box } = await setupAccount("snd-1", [
      "snd-1@example.com",
      "alias-1@example.com",
    ]);
    const up = await upload(app, accountId, bytes("PDFDATA"), "application/pdf");
    const ids = await call(app, [["Identity/get", { accountId }, "i"]]);
    const identities = resp(ids).args.list as any[];
    expect(identities.map((i) => i.email)).toEqual(["snd-1@example.com", "alias-1@example.com"]);
    expect(identities[0]).toMatchObject({
      name: "snd-1",
      mayDelete: false,
      textSignature: "",
      htmlSignature: "",
    });
    const identityId = identities[0].id;

    const r = await call(app, [
      [
        "Email/set",
        {
          accountId,
          create: {
            "send-1": {
              from: [{ name: "Ana", email: "snd-1@example.com" }],
              to: [{ name: "Carl", email: "carl@example.net" }],
              cc: [{ email: "dora@example.net" }],
              bcc: [{ email: "secret@example.net" }],
              subject: "Quarterly plan",
              keywords: { $seen: true, $draft: true },
              mailboxIds: { [box("drafts")]: true },
              bodyValues: {
                text: { value: "Plan attached." },
                html: { value: "<p>Plan attached.</p>" },
              },
              textBody: [{ partId: "text", type: "text/plain" }],
              htmlBody: [{ partId: "html", type: "text/html" }],
              attachments: [
                {
                  blobId: up.json.blobId,
                  type: "application/pdf",
                  name: "plan.pdf",
                  disposition: "attachment",
                },
              ],
              "header:Disposition-Notification-To:asText": "snd-1@example.com",
            },
          },
        },
        "0",
      ],
      [
        "EmailSubmission/set",
        {
          accountId,
          create: { 1: { emailId: "#send-1", identityId } },
          onSuccessUpdateEmail: {
            "#1": { [`mailboxIds`]: { [box("sent")]: true }, "keywords/$draft": null },
          },
        },
        "1",
      ],
      [
        "EmailSubmission/get",
        { accountId, ids: ["#1"], properties: ["deliveryStatus", "undoStatus", "envelope"] },
        "st",
      ],
    ]);
    const [emailSet, subSet, implicit, sub] = r.methodResponses;
    expect(emailSet![1].created["send-1"]).toMatchObject({
      id: expect.any(String),
      threadId: expect.any(String),
    });
    expect(subSet![0]).toBe("EmailSubmission/set");
    expect(subSet![1].created["1"]).toMatchObject({ id: expect.any(String), undoStatus: "final" });
    expect(implicit![0]).toBe("Email/set");
    expect(implicit![2]).toBe("1");
    const emailId = emailSet![1].created["send-1"].id;
    expect(implicit![1].updated).toEqual({ [emailId]: null });
    expect(sub![0]).toBe("EmailSubmission/get");
    expect(sub![1].list[0]).toMatchObject({
      undoStatus: "final",
      envelope: {
        mailFrom: { email: "snd-1@example.com" },
        rcptTo: [
          { email: "carl@example.net" },
          { email: "dora@example.net" },
          { email: "secret@example.net" },
        ],
      },
    });
    expect(Object.keys(sub![1].list[0].deliveryStatus)).toHaveLength(3);
    expect(sub![1].list[0].deliveryStatus["carl@example.net"]).toMatchObject({
      delivered: "queued",
    });

    // The provider got one raw MIME request: all recipients, no Bcc header
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).toContain("/messages.mime");
    const form = init.body as FormData;
    expect(form.getAll("to")).toEqual([
      "carl@example.net",
      "dora@example.net",
      "secret@example.net",
    ]);
    const sentRaw = await (form.get("message") as Blob).text();
    expect(sentRaw).not.toMatch(/^bcc:/im);
    expect(sentRaw).toMatch(/^To: .*carl@example\.net/im);
    expect(sentRaw).toContain("Disposition-Notification-To: snd-1@example.com");
    expect(sentRaw).toContain("plan.pdf");

    // Email moved to Sent, $draft gone, Bcc kept in the stored copy
    const g = await call(app, [
      [
        "Email/get",
        {
          accountId,
          ids: [emailId],
          properties: ["mailboxIds", "keywords", "bcc", "subject", "hasAttachment"],
        },
        "g",
      ],
    ]);
    const e = resp(g).args.list[0];
    expect(e.mailboxIds).toEqual({ [box("sent")]: true });
    expect(e.keywords).toEqual({ $seen: true });
    expect(e.bcc).toEqual([{ name: null, email: "secret@example.net" }]);
    const stored = await app.request(
      `/jmap/download/${accountId}/${emailSet![1].created["send-1"].blobId}/sent.eml`,
      {},
      env,
    );
    expect(stored.status).toBe(200);
    expect(await stored.text()).toMatch(/^Bcc: .*secret@example\.net/im);

    // After the parse alarm the attachment is downloadable from the sent copy
    await runDurableObjectAlarm(accountStub(env, accountId));
    const full = await call(app, [
      [
        "Email/get",
        { accountId, ids: [emailId], properties: ["attachments", "hasAttachment", "preview"] },
        "g",
      ],
    ]);
    const att = resp(full).args.list[0].attachments[0];
    expect(att).toMatchObject({ name: "plan.pdf", type: "application/pdf", size: 7 });
    expect(resp(full).args.list[0].hasAttachment).toBe(true);
    const dl = await app.request(
      `/jmap/download/${accountId}/${att.blobId}/plan.pdf?type=application%2Fpdf`,
      {},
      env,
    );
    expect(await dl.text()).toBe("PDFDATA");
    expect(dl.headers.get("content-type")).toBe("application/pdf");

    const counts = await call(app, [
      ["Mailbox/get", { accountId, ids: [box("drafts"), box("sent")] }, "m"],
    ]);
    const [drafts, sent] = resp(counts).args.list;
    expect(drafts.totalEmails).toBe(0);
    expect(sent.totalEmails).toBe(1);
    expect(sent.unreadEmails).toBe(0);
  });
});
