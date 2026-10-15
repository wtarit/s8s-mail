import { env } from "cloudflare:workers";
import { runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";
import { accountStub } from "../../src/store/subscribe";
import { MAX_PARSE_ATTEMPTS } from "../../src/store/account-do";
import { buildRaw, seedAccount } from "../helpers/mail";
import { emails, deliver } from "../helpers/ingest";

describe("deferred body parse (alarm)", () => {
  it("parses preview, attachment flag, body structure, part blobs and FTS", async () => {
    await seedAccount("ing-parse", ["parse@example.com"]);
    const stub = accountStub(env, "ing-parse");
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
    // The scheduled alarm may also fire on its own in the test runtime; run it explicitly
    // until the message is parsed.
    await vi.waitFor(async () => {
      await runDurableObjectAlarm(stub);
      expect((await emails("ing-parse"))[0]!.parse_state).toBe("parsed");
    });

    const [row] = await emails("ing-parse");
    expect(row).toMatchObject({ parse_state: "parsed", has_attachment: 1, parse_attempts: 1 });
    expect(row!.preview).toBe("The zebrafish results are attached. Regards");
    expect(row!.preview.length).toBeLessThanOrEqual(256);

    const structure = JSON.parse(row!.body_structure!);
    expect(structure.type).toBe("multipart/mixed");
    const attachment = structure.subParts.at(-1);
    expect(attachment).toMatchObject({
      partId: "3",
      name: "report.txt",
      disposition: "attachment",
    });
    expect(attachment.blobId).toBe(`${row!.blob_id}-3`);
    // Decoded part blobs were materialized next to the raw message.
    const part = await env.BLOBS.get(`ing-parse/${attachment.blobId}`);
    expect(await part!.text()).toBe("attachment body");
    expect(await (await env.BLOBS.get(`ing-parse/${row!.blob_id}-1`))!.text()).toContain(
      "zebrafish",
    );

    // FTS hit on body and on subject; miss otherwise.
    const hits = (term: string) =>
      runInDurableObject(stub, (_i, state) =>
        state.storage.sql
          .exec<{ id: string }>(
            "SELECT e.id FROM email_fts f JOIN email e ON e.rowid = f.rowid WHERE email_fts MATCH ?",
            term,
          )
          .toArray()
          .map((r) => r.id),
      );
    expect(await hits("zebrafish")).toEqual([row!.id]);
    expect(await hits("subject:quarterly")).toEqual([row!.id]);
    expect(await hits("nonexistentterm")).toEqual([]);
  });

  it("derives preview and FTS text from an HTML-only message", async () => {
    await seedAccount("ing-html", ["html@example.com"]);
    const raw = buildRaw().replace(
      "Content-Type: text/plain; charset=utf-8\r\n\r\nHello Ana,\r\nthis is the body.",
      "Content-Type: text/html; charset=utf-8\r\n\r\n<p>Hello <b>Ana</b></p>",
    );
    await deliver("html@example.com", raw);
    await vi.waitFor(async () => {
      await runDurableObjectAlarm(accountStub(env, "ing-html"));
      expect((await emails("ing-html"))[0]!.parse_state).toBe("parsed");
    });
    const [row] = await emails("ing-html");
    expect(row!.preview).toBe("Hello Ana");
    expect(row!.has_attachment).toBe(0);
    const structure = JSON.parse(row!.body_structure!);
    expect(structure).toMatchObject({ partId: "2", type: "text/html" });
    const textBody = JSON.parse(
      await runInDurableObject(
        accountStub(env, "ing-html"),
        (_i, state) =>
          state.storage.sql.exec<{ t: string }>("SELECT text_body AS t FROM email").one().t,
      ),
    );
    expect(textBody).toEqual([structure]); // textBody falls back to the HTML part
  });

  it("caps the preview at 256 characters", async () => {
    await seedAccount("ing-preview", ["preview@example.com"]);
    await deliver("preview@example.com", buildRaw({ text: "word ".repeat(200) }));
    await vi.waitFor(async () => {
      await runDurableObjectAlarm(accountStub(env, "ing-preview"));
      expect((await emails("ing-preview"))[0]!.parse_state).toBe("parsed");
    });
    const [row] = await emails("ing-preview");
    expect(row!.preview).toHaveLength(256);
  });

  it("parses all pending messages, rescheduling the alarm between them", async () => {
    await seedAccount("ing-many", ["many@example.com"]);
    const stub = accountStub(env, "ing-many");
    await deliver("many@example.com", buildRaw({ messageId: "<a@example.com>" }));
    await deliver("many@example.com", buildRaw({ messageId: "<b@example.com>" }));
    await vi.waitFor(async () => {
      await runDurableObjectAlarm(stub);
      expect((await emails("ing-many")).map((r) => r.parse_state)).toEqual(["parsed", "parsed"]);
    });
  });

  it("counts attempts and ends `failed` when the parse keeps failing", async () => {
    await seedAccount("ing-bad", ["bad@example.com"]);
    const stub = accountStub(env, "ing-bad");
    await deliver("bad@example.com", buildRaw());
    const [row] = await emails("ing-bad");
    await env.BLOBS.delete(`ing-bad/${row!.blob_id}`); // the raw message disappears

    await vi.waitFor(async () => {
      await runDurableObjectAlarm(stub);
      expect((await emails("ing-bad"))[0]!.parse_state).toBe("failed");
    });
    const [failed] = await emails("ing-bad");
    expect(failed).toMatchObject({ parse_attempts: MAX_PARSE_ATTEMPTS });
    expect(failed!.parse_error).toMatch(/missing/);
    // Header data is still served for a failed message.
    expect(failed!.subject).toBe("Hello");
  });

  it("marks a message failed when attempts were exhausted by killed invocations", async () => {
    await seedAccount("ing-killed", ["killed@example.com"]);
    const stub = accountStub(env, "ing-killed");
    await deliver("killed@example.com", buildRaw());
    // Simulate three invocations killed for CPU: the counter was persisted, nothing else.
    await runInDurableObject(stub, (_i, state) => {
      state.storage.sql.exec("UPDATE email SET parse_attempts = ?", MAX_PARSE_ATTEMPTS);
    });
    await vi.waitFor(async () => {
      await runDurableObjectAlarm(stub);
      expect((await emails("ing-killed"))[0]!.parse_state).toBe("failed");
    });
  });
});
