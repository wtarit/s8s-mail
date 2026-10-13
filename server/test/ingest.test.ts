import { env } from "cloudflare:workers";
import { runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";
import { handleEmail } from "../src/mail/ingest";
import { accountStub, subscribeToAccount } from "../src/store/subscribe";
import { MAX_PARSE_ATTEMPTS } from "../src/store/account-do";
import { buildRaw, ctx, fakeMessage, seedAccount } from "./helpers/mail";

type EmailRow = {
  id: string;
  blob_id: string;
  thread_id: string;
  subject: string | null;
  preview: string;
  has_attachment: number;
  parse_state: string;
  parse_attempts: number;
  parse_error: string | null;
  size: number;
  body_structure: string | null;
};

async function emails(accountId: string): Promise<EmailRow[]> {
  return runInDurableObject(accountStub(env, accountId), (_i, state) =>
    state.storage.sql.exec<EmailRow>("SELECT * FROM email ORDER BY received_at, rowid").toArray(),
  );
}

async function deliver(to: string, raw: string) {
  const { message, setReject } = fakeMessage(to, raw);
  await handleEmail(message, env, ctx);
  return { setReject };
}

async function r2Keys(accountId: string): Promise<string[]> {
  return (await env.BLOBS.list({ prefix: `${accountId}/` })).objects.map((o) => o.key);
}

describe("email() handler", () => {
  it("stores a message for a known recipient: R2 + DO row + inbox + state bump", async () => {
    await seedAccount("ing-known", ["ana@example.com"]);
    const stub = accountStub(env, "ing-known");
    const raw = buildRaw({ subject: "Greetings" });

    const { setReject } = await deliver("ana@example.com", raw);
    expect(setReject).not.toHaveBeenCalled();

    const [row] = await emails("ing-known");
    expect(row).toMatchObject({
      subject: "Greetings",
      size: new TextEncoder().encode(raw).byteLength,
      parse_state: "pending",
      preview: "",
    });
    // Raw message streamed to R2 under accountId/blobId, byte for byte.
    const obj = await env.BLOBS.get(`ing-known/${row!.blob_id}`);
    expect(await obj!.text()).toBe(raw);

    const membership = await runInDurableObject(stub, (_i, state) =>
      state.storage.sql
        .exec<{ role: string }>(
          "SELECT m.role FROM email_mailbox em JOIN mailbox m ON m.id = em.mailbox_id WHERE em.email_id = ?",
          row!.id,
        )
        .toArray(),
    );
    expect(membership).toEqual([{ role: "inbox" }]);

    const state = await stub.getState();
    expect(Number(state.Email)).toBeGreaterThan(0);
    expect(Number(state.EmailDelivery)).toBeGreaterThan(0);
    expect(Number(state.Thread)).toBeGreaterThan(0);
  });

  it("routes plus-addressed and mixed-case recipients to the base address", async () => {
    await seedAccount("ing-plus", ["ana@example.com".replace("ana", "plus-ana")]);
    const { setReject } = await deliver("Plus-Ana+Newsletters@Example.com", buildRaw());
    expect(setReject).not.toHaveBeenCalled();
    expect(await emails("ing-plus")).toHaveLength(1);
  });

  it("delivers aliases to the same account", async () => {
    await seedAccount("ing-alias", ["ing-alias@example.com", "ing-alias-2@example.net"]);
    await deliver("ing-alias-2@example.net", buildRaw());
    expect(await emails("ing-alias")).toHaveLength(1);
  });

  it("rejects an unknown recipient and stores nothing", async () => {
    await seedAccount("ing-unknown", ["known@example.com"]);
    const before = (await env.BLOBS.list()).objects.length;
    const { setReject } = await deliver("nobody@example.com", buildRaw());
    expect(setReject).toHaveBeenCalledWith("5.1.1 Recipient address rejected");
    expect((await env.BLOBS.list()).objects.length).toBe(before);
  });

  it("deletes the R2 object and rethrows when the DO call fails", async () => {
    await seedAccount("ing-fail", ["fail@example.com"]);
    const stub = accountStub(env, "ing-fail");
    await stub.init("ing-fail");
    await runInDurableObject(stub, (_i, state) => {
      state.storage.sql.exec("DELETE FROM mailbox WHERE role = 'inbox'");
    });
    await expect(deliver("fail@example.com", buildRaw())).rejects.toThrow();
    expect(await r2Keys("ing-fail")).toEqual([]);
  });

  it("threads a reply into the same thread", async () => {
    await seedAccount("ing-thread", ["thread@example.com"]);
    await deliver(
      "thread@example.com",
      buildRaw({ subject: "Plan", messageId: "<plan1@example.com>" }),
    );
    await deliver(
      "thread@example.com",
      buildRaw({
        subject: "Re: Plan",
        messageId: "<plan2@example.com>",
        inReplyTo: "<plan1@example.com>",
        references: "<plan1@example.com>",
      }),
    );
    const rows = await emails("ing-thread");
    expect(rows).toHaveLength(2);
    expect(rows[0]!.thread_id).toBe(rows[1]!.thread_id);
  });
});

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

describe("push", () => {
  it("sends a StateChange to WebSocket subscribers after ingest and after parse", async () => {
    await seedAccount("ing-push", ["push@example.com"]);
    const stub = accountStub(env, "ing-push");
    const ws = await subscribeToAccount(env, "ing-push");
    const received: unknown[] = [];
    ws.addEventListener("message", (e) => received.push(JSON.parse(e.data as string)));

    // Incoming messages are ignored; "ping" is answered by the runtime.
    ws.send("ignored");

    await deliver("push@example.com", buildRaw());
    // First message: the delivery. Second: the parse alarm (which may fire on its own).
    await vi.waitFor(async () => {
      await runDurableObjectAlarm(stub);
      expect(received).toHaveLength(2);
    });
    type Msg = { "@type": string; changed: Record<string, Record<string, string>> };
    const [first, second] = received as [Msg, Msg];
    expect(first["@type"]).toBe("StateChange");
    expect(Object.keys(first.changed)).toEqual(["ing-push"]);
    expect(Object.keys(first.changed["ing-push"]!).toSorted()).toEqual([
      "Email",
      "EmailDelivery",
      "Mailbox",
      "Thread",
    ]);
    expect(Number(second.changed["ing-push"]!.Email)).toBeGreaterThan(
      Number(first.changed["ing-push"]!.Email),
    );
    expect(second.changed["ing-push"]).toEqual(await stub.getState());
    ws.close();
  });

  it("rejects non-WebSocket requests to /subscribe", async () => {
    const res = await accountStub(env, "ing-push-http").fetch("https://do/subscribe");
    expect(res.status).toBe(426);
  });
});
