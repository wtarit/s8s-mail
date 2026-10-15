/* oxlint-disable typescript/no-explicit-any -- JSON responses are read untyped in tests */
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { call, resp, setupAccount } from "../helpers/jmap";
import { fetchSpy, installMailgunFetchMock } from "../helpers/jmap-send";

installMailgunFetchMock();

describe("drafts and sending", () => {
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
});
