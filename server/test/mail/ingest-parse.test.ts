/* oxlint-disable typescript/no-explicit-any -- JSON responses are read untyped in tests */
import { env } from "cloudflare:workers";
import { runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { MAX_PARSE_ATTEMPTS } from "../../src/store/account-do";
import { accountStub } from "../../src/store/subscribe";
import { setupAccount } from "../helpers/jmap";
import { buildRaw } from "../helpers/mail";
import {
  deliver,
  downloadText,
  getEmails,
  r2Keys,
  searchIds,
  settleParse,
} from "../helpers/ingest";

const BODY_PROPS = ["preview", "hasAttachment", "bodyStructure", "textBody", "attachments"];
const BODY_VALUES = { fetchTextBodyValues: true, fetchHTMLBodyValues: true };

describe("deferred body parse (alarm)", () => {
  it("parses preview, attachments, bodies and search text", async () => {
    const { app, accountId } = await setupAccount("ing-parse", ["parse@example.com"]);
    await deliver(
      "parse@example.com",
      buildRaw({
        subject: "Quarterly report",
        text: "The zebrafish results are attached.\r\n\r\nRegards",
        attachment: {
          filename: "report.txt",
          mimeType: "text/plain",
          base64: btoa("attachment body"),
        },
      }),
    );
    await settleParse(accountId);

    const [email] = await getEmails(app, accountId, [...BODY_PROPS, "bodyValues"], BODY_VALUES);
    expect(email!.preview).toBe("The zebrafish results are attached. Regards");
    expect(email!.hasAttachment).toBe(true);
    expect(email!.bodyStructure.type).toBe("multipart/mixed");
    expect(email!.attachments).toMatchObject([
      { name: "report.txt", type: "text/plain", disposition: "attachment" },
    ]);
    const textPart = email!.textBody[0];
    expect(email!.bodyValues[textPart.partId].value).toContain("zebrafish");
    // Attachment content is downloadable, decoded.
    expect(await downloadText(app, accountId, email!.attachments[0].blobId, "report.txt")).toBe(
      "attachment body",
    );

    // Search finds the body and the subject; a term that is nowhere finds nothing.
    expect(await searchIds(app, accountId, { text: "zebrafish" })).toEqual([email!.id]);
    expect(await searchIds(app, accountId, { subject: "quarterly" })).toEqual([email!.id]);
    expect(await searchIds(app, accountId, { text: "nonexistentterm" })).toEqual([]);
  });

  it("derives preview and search text from an HTML-only message", async () => {
    const { app, accountId } = await setupAccount("ing-html", ["html@example.com"]);
    const raw = buildRaw().replace(
      "Content-Type: text/plain; charset=utf-8\r\n\r\nHello Ana,\r\nthis is the body.",
      "Content-Type: text/html; charset=utf-8\r\n\r\n<p>Hello <b>Ana</b> and zucchini</p>",
    );
    await deliver("html@example.com", raw);
    await settleParse(accountId);

    const [email] = await getEmails(app, accountId, BODY_PROPS);
    expect(email!.preview).toBe("Hello Ana and zucchini");
    expect(email!.hasAttachment).toBe(false);
    expect(email!.bodyStructure).toMatchObject({ type: "text/html" });
    // textBody falls back to the HTML part (RFC 8621 §4.1.4)
    expect(email!.textBody).toHaveLength(1);
    expect(email!.textBody[0]).toMatchObject({
      type: "text/html",
      partId: email!.bodyStructure.partId,
    });
    expect(await searchIds(app, accountId, { text: "zucchini" })).toEqual([email!.id]);
  });

  it("caps the preview at 256 characters", async () => {
    const { app, accountId } = await setupAccount("ing-preview", ["preview@example.com"]);
    await deliver("preview@example.com", buildRaw({ text: "word ".repeat(200) }));
    await settleParse(accountId);
    const [email] = await getEmails(app, accountId, ["preview"]);
    expect(email!.preview).toHaveLength(256);
  });

  it("parses all pending messages, rescheduling the alarm between them", async () => {
    const { app, accountId } = await setupAccount("ing-many", ["many@example.com"]);
    await deliver("many@example.com", buildRaw({ messageId: "<a@example.com>", text: "alpha" }));
    await deliver("many@example.com", buildRaw({ messageId: "<b@example.com>", text: "bravo" }));
    await settleParse(accountId);
    const emails = await getEmails(app, accountId, ["preview"]);
    expect(emails.map((e) => e.preview).toSorted()).toEqual(["alpha", "bravo"]);
  });

  it("keeps serving headers and stops retrying when the parse keeps failing", async () => {
    const { app, accountId } = await setupAccount("ing-bad", ["bad@example.com"]);
    await deliver("bad@example.com", buildRaw());
    // Fault injection: the raw message disappears from R2 before the parse runs.
    for (const key of await r2Keys(accountId)) await env.BLOBS.delete(key);

    await settleParse(accountId);
    const [email] = await getEmails(app, accountId, ["subject", "preview", "from"]);
    expect(email).toMatchObject({ subject: "Hello", preview: "" });
    expect(email!.from).toEqual([{ name: "Bob", email: "bob@example.com" }]);
    // Given up: no further alarm is scheduled.
    expect(await runDurableObjectAlarm(accountStub(env, accountId))).toBe(false);
  });

  it("gives up on a message whose attempts were used up by killed invocations", async () => {
    const { app, accountId } = await setupAccount("ing-killed", ["killed@example.com"]);
    await deliver("killed@example.com", buildRaw());
    // Fault injection: three invocations killed for CPU; the counter was persisted, nothing else.
    await runInDurableObject(accountStub(env, accountId), (_i, state) => {
      state.storage.sql.exec("UPDATE email SET parse_attempts = ?", MAX_PARSE_ATTEMPTS);
    });
    await settleParse(accountId);
    // The raw message is intact, but it is not parsed again: only headers are served.
    const [email] = await getEmails(app, accountId, ["subject", "preview"]);
    expect(email).toMatchObject({ subject: "Hello", preview: "" });
    expect(await runDurableObjectAlarm(accountStub(env, accountId))).toBe(false);
  });
});
