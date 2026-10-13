/* oxlint-disable typescript/no-explicit-any -- JSON responses are read untyped in tests */
import { env } from "cloudflare:workers";
import { runDurableObjectAlarm } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { accountStub } from "../src/store/subscribe";
import { call, resp, setupAccount, type testApp } from "./helpers/jmap";

const bytes = (s: string) => new TextEncoder().encode(s);

async function upload(
  app: ReturnType<typeof testApp>,
  accountId: string,
  body: Uint8Array,
  type: string,
) {
  const res = await app.request(
    `/jmap/upload/${accountId}/`,
    { method: "POST", headers: { "content-type": type }, body },
    env,
  );
  return { res, json: (await res.clone().json()) as any };
}

let fetchSpy: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  (env as unknown as Record<string, string>).MAILGUN_API = "key-test";
  fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(
    async () =>
      new Response(JSON.stringify({ id: "<mg-1@example.com>", message: "Queued" }), {
        status: 200,
      }),
  );
});
afterEach(() => {
  fetchSpy.mockRestore();
});

describe("upload and download", () => {
  it("stores uploads in R2 and serves them back with safe headers, per account", async () => {
    const a = await setupAccount("up-1", ["up-1@example.com"]);
    const b = await setupAccount("up-2", ["up-2@example.com"]);
    const { res, json } = await upload(a.app, a.accountId, bytes("hello attachment"), "text/plain");
    expect(res.status).toBe(201);
    expect(json).toMatchObject({ accountId: "up-1", type: "text/plain", size: 16 });
    expect(json.blobId).toMatch(/^U[0-9a-f]{32}$/);
    expect(await env.BLOBS.head(`up-1/${json.blobId}`)).not.toBeNull();

    const dl = await a.app.request(
      `/jmap/download/up-1/${json.blobId}/${encodeURIComponent('résumé "x".txt')}?type=text%2Fplain`,
      {},
      env,
    );
    expect(dl.status).toBe(200);
    expect(await dl.text()).toBe("hello attachment");
    expect(dl.headers.get("content-type")).toBe("text/plain");
    expect(dl.headers.get("cache-control")).toBe("private, immutable, max-age=31536000");
    const cd = dl.headers.get("content-disposition")!;
    expect(cd).toContain("attachment;");
    expect(cd).toContain("filename*=UTF-8''r%C3%A9sum%C3%A9%20%22x%22.txt");
    expect(cd).toContain('filename="r_sum_ _x_.txt"');
    expect(dl.headers.get("x-content-type-options")).toBe("nosniff");

    // another account's session cannot read it, nor can the blob be named across accounts
    const other = await b.app.request(`/jmap/download/up-2/${json.blobId}/x.txt`, {}, env);
    expect(other.status).toBe(404);
    const foreign = await b.app.request(`/jmap/download/up-1/${json.blobId}/x.txt`, {}, env);
    expect(foreign.status).toBe(404);
    const traversal = await a.app.request(`/jmap/download/up-1/..%2Fup-2%2Fx/x.txt`, {}, env);
    expect(traversal.status).toBe(404);
    // cannot upload into someone else's account
    const bad = await b.app.request(
      "/jmap/upload/up-1/",
      { method: "POST", headers: { "content-type": "text/plain" }, body: "x" },
      env,
    );
    expect(bad.status).toBe(404);
  });

  it("rejects uploads over maxSizeUpload with 413 and a JMAP problem body", async () => {
    const a = await setupAccount("up-3", ["up-3@example.com"]);
    const session = (await (await a.app.request("/jmap/session", {}, env)).json()) as any;
    const max = session.capabilities["urn:ietf:params:jmap:core"].maxSizeUpload as number;
    const res = await a.app.request(
      "/jmap/upload/up-3/",
      {
        method: "POST",
        headers: { "content-type": "application/octet-stream", "content-length": String(max + 1) },
        body: new Uint8Array(8),
      },
      env,
    );
    expect(res.status).toBe(413);
    expect(res.headers.get("content-type")).toContain("application/problem+json");
    expect(await res.json()).toMatchObject({
      type: "urn:ietf:params:jmap:error:limit",
      limit: "maxSizeUpload",
    });
  });
});

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
    const stored = await env.BLOBS.get(`snd-1/${emailSet![1].created["send-1"].blobId}`);
    expect(await stored!.text()).toMatch(/^Bcc: .*secret@example\.net/im);

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

  it("maps validation and provider failures to SetErrors", async () => {
    const { app, accountId, box } = await setupAccount("snd-2", [
      "snd-2@example.com",
      "alias-2@example.com",
    ]);
    const identities = resp(await call(app, [["Identity/get", { accountId }, "i"]])).args
      .list as any[];
    const mk = async (over: Record<string, unknown> = {}) => {
      const r = await call(app, [
        [
          "Email/set",
          {
            accountId,
            create: {
              d: {
                from: [{ email: "snd-2@example.com" }],
                to: [{ email: "carl@example.net" }],
                subject: "x",
                keywords: { $draft: true },
                mailboxIds: { [box("drafts")]: true },
                bodyValues: { 1: { value: "hi" } },
                textBody: [{ partId: "1" }],
                ...over,
              },
            },
          },
          "c",
        ],
      ]);
      return resp(r).args.created.d.id as string;
    };
    const submit = async (
      emailId: string,
      identityId: string,
      extra: Record<string, unknown> = {},
    ) =>
      resp(
        await call(app, [
          [
            "EmailSubmission/set",
            { accountId, create: { s: { emailId, identityId, ...extra } } },
            "s",
          ],
        ]),
      ).args;

    // wrong identity -> forbiddenFrom
    const e1 = await mk();
    expect((await submit(e1, identities[1].id)).notCreated.s.type).toBe("forbiddenFrom");
    // foreign MAIL FROM -> forbiddenMailFrom
    expect(
      (
        await submit(e1, identities[0].id, {
          envelope: {
            mailFrom: { email: "evil@example.net" },
            rcptTo: [{ email: "x@example.net" }],
          },
        })
      ).notCreated.s.type,
    ).toBe("forbiddenMailFrom");
    // no recipients
    const e2 = await mk({ to: [] });
    expect((await submit(e2, identities[0].id)).notCreated.s.type).toBe("noRecipients");
    // unknown identity / email
    expect((await submit(e1, "nope")).notCreated.s.properties).toEqual(["identityId"]);
    expect((await submit("ghost", identities[0].id)).notCreated.s.properties).toEqual(["emailId"]);
    // too many recipients (Mailgun: 1000)
    const many = Array.from({ length: 1001 }, (_, i) => ({ email: `r${i}@example.net` }));
    const e3 = await mk({ to: many });
    const tm = (await submit(e3, identities[0].id)).notCreated.s;
    expect(tm).toMatchObject({ type: "tooManyRecipients", maxRecipients: 1000 });
    expect(fetchSpy).not.toHaveBeenCalled();

    // provider failures
    fetchSpy.mockImplementation(
      async () => new Response(JSON.stringify({ message: "boom" }), { status: 503 }),
    );
    const retry = (await submit(e1, identities[0].id)).notCreated.s;
    expect(retry.type).toBe("serverFail");
    fetchSpy.mockImplementation(
      async () => new Response(JSON.stringify({ message: "bad" }), { status: 400 }),
    );
    expect((await submit(e1, identities[0].id)).notCreated.s.type).toBe("invalidEmail");
    fetchSpy.mockImplementation(
      async () => new Response(JSON.stringify({ message: "no" }), { status: 403 }),
    );
    expect((await submit(e1, identities[0].id)).notCreated.s.type).toBe("forbiddenToSend");
    // a failed submission leaves the email where it was and records nothing
    const subs = await call(app, [["EmailSubmission/query", { accountId }, "q"]]);
    expect(resp(subs).args.ids).toEqual([]);
    const still = await call(app, [
      ["Email/get", { accountId, ids: [e1], properties: ["mailboxIds"] }, "g"],
    ]);
    expect(resp(still).args.list[0].mailboxIds).toEqual({ [box("drafts")]: true });
  });

  it("reports blobNotFound, invalid properties and tooLarge on Email/set create", async () => {
    const { app, accountId, box } = await setupAccount("snd-3", ["snd-3@example.com"]);
    const base = {
      from: [{ email: "snd-3@example.com" }],
      to: [{ email: "c@example.net" }],
      mailboxIds: { [box("drafts")]: true },
      bodyValues: { 1: { value: "hi" } },
      textBody: [{ partId: "1" }],
    };
    const session = (await (await app.request("/jmap/session", {}, env)).json()) as any;
    const max = session.accounts["snd-3"].accountCapabilities["urn:ietf:params:jmap:mail"]
      .maxSizeAttachmentsPerEmail as number;
    // fabricate a big blob directly in R2 (bigger than the attachment limit)
    await env.BLOBS.put("snd-3/Ubig", new Uint8Array(max + 1));
    const r = await call(app, [
      [
        "Email/set",
        {
          accountId,
          create: {
            missing: { ...base, attachments: [{ blobId: "Unope", type: "text/plain", name: "a" }] },
            big: {
              ...base,
              attachments: [{ blobId: "Ubig", type: "application/octet-stream", name: "big" }],
            },
            nobox: { ...base, mailboxIds: { ghost: true } },
            nofrom: { ...base, from: [] },
            extra: { ...base, id: "x" },
            nokw: { ...base, keywords: { "bad kw": true } },
            ok: { ...base, subject: "ok" },
          },
        },
        "c",
      ],
    ]);
    const a = resp(r).args;
    expect(a.notCreated.missing).toMatchObject({ type: "blobNotFound", notFound: ["Unope"] });
    expect(a.notCreated.big).toMatchObject({ type: "tooLarge", maxSize: max });
    expect(a.notCreated.nobox.type).toBe("invalidProperties");
    expect(a.notCreated.nobox.properties).toEqual(["mailboxIds"]);
    expect(a.notCreated.nofrom.properties).toEqual(["from"]);
    expect(a.notCreated.extra.properties).toEqual(["id"]);
    expect(a.notCreated.nokw.properties).toEqual(["keywords"]);
    expect(a.created.ok.id).toBeTruthy();
    // failed creates leave no orphan blob
    const keys = (await env.BLOBS.list({ prefix: "snd-3/M" })).objects;
    expect(keys).toHaveLength(1);
  });

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

describe("Identity/set", () => {
  it("updates name and signatures, forbids create and destroy", async () => {
    const { app, accountId } = await setupAccount("idn-1", [
      "idn-1@example.com",
      "alias-idn@example.com",
    ]);
    const first = resp(await call(app, [["Identity/get", { accountId }, "g"]]));
    const [id1, id2] = first.args.list.map((i: any) => i.id);
    expect(id1).toMatch(/^i[0-9a-f]{24}$/);
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
