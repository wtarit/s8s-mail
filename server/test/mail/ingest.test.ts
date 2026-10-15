/* oxlint-disable typescript/no-explicit-any -- JSON responses are read untyped in tests */
import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { accountStub } from "../../src/store/subscribe";
import { deliver as deliverJmap, resp, call, setupAccount } from "../helpers/jmap";
import { buildRaw, seedAccount } from "../helpers/mail";
import { deliver, downloadText, getEmails, r2Keys, searchIds, stateOf } from "../helpers/ingest";

describe("email() handler", () => {
  it("stores a message for a known recipient: readable in the inbox, byte for byte", async () => {
    const { app, accountId, box } = await setupAccount("ing-known", ["ana@example.com"]);
    const raw = buildRaw({ subject: "Greetings" });
    const before = {
      Email: await stateOf(app, accountId, "Email"),
      Thread: await stateOf(app, accountId, "Thread"),
      Mailbox: await stateOf(app, accountId, "Mailbox"),
    };

    const { setReject } = await deliver("ana@example.com", raw);
    expect(setReject).not.toHaveBeenCalled();

    const [email] = await getEmails(app, accountId, [
      "subject",
      "size",
      "mailboxIds",
      "threadId",
      "blobId",
    ]);
    expect(email).toMatchObject({
      subject: "Greetings",
      size: new TextEncoder().encode(raw).byteLength,
      mailboxIds: { [box("inbox")]: true },
    });
    expect(await searchIds(app, accountId, { inMailbox: box("inbox") })).toHaveLength(1);
    // The raw message is downloadable unchanged.
    expect(await downloadText(app, accountId, email!.blobId, "greetings.eml")).toBe(raw);

    // Delivery changes what clients see: new states for emails, threads and mailbox counts.
    expect(await stateOf(app, accountId, "Email")).not.toBe(before.Email);
    expect(await stateOf(app, accountId, "Thread")).not.toBe(before.Thread);
    expect(await stateOf(app, accountId, "Mailbox")).not.toBe(before.Mailbox);
  });

  it("routes plus-addressed and mixed-case recipients to the base address", async () => {
    const { app, accountId } = await setupAccount("ing-plus", ["plus-ana@example.com"]);
    const { setReject } = await deliver("Plus-Ana+Newsletters@Example.com", buildRaw());
    expect(setReject).not.toHaveBeenCalled();
    expect(await searchIds(app, accountId)).toHaveLength(1);
  });

  it("delivers aliases to the same account", async () => {
    const { app, accountId } = await setupAccount("ing-alias", [
      "ing-alias@example.com",
      "ing-alias-2@example.net",
    ]);
    await deliver("ing-alias-2@example.net", buildRaw());
    expect(await searchIds(app, accountId)).toHaveLength(1);
  });

  it("rejects an unknown recipient and stores nothing", async () => {
    const { app, accountId } = await setupAccount("ing-unknown", ["known@example.com"]);
    const before = (await env.BLOBS.list()).objects.length;
    const { setReject } = await deliver("nobody@example.com", buildRaw());
    expect(setReject).toHaveBeenCalledWith("5.1.1 Recipient address rejected");
    expect((await env.BLOBS.list()).objects.length).toBe(before);
    expect(await searchIds(app, accountId)).toEqual([]);
  });

  it("deletes the R2 object and rethrows when the DO call fails", async () => {
    await seedAccount("ing-fail", ["fail@example.com"]);
    const stub = accountStub(env, "ing-fail");
    await stub.init("ing-fail");
    // Fault injection: the inbox disappears, so the DO cannot file the message.
    await runInDurableObject(stub, (_i, state) => {
      state.storage.sql.exec("DELETE FROM mailbox WHERE role = 'inbox'");
    });
    await expect(deliver("fail@example.com", buildRaw())).rejects.toThrow();
    expect(await r2Keys("ing-fail")).toEqual([]);
  });

  it("threads a reply into the same thread, unrelated mail into another", async () => {
    const { app, accountId } = await setupAccount("ing-thread", ["thread@example.com"]);
    const to = "thread@example.com";
    await deliverJmap(accountId, to, { subject: "Plan", messageId: "<plan1@example.com>" });
    await deliverJmap(accountId, to, {
      subject: "Re: Plan",
      messageId: "<plan2@example.com>",
      inReplyTo: "<plan1@example.com>",
      references: "<plan1@example.com>",
    });
    await deliverJmap(accountId, to, { subject: "Lunch", messageId: "<lunch1@example.com>" });

    const emails = await getEmails(app, accountId, ["subject", "threadId"]);
    const by = (subject: string) => emails.find((e) => e.subject === subject)!;
    expect(by("Re: Plan").threadId).toBe(by("Plan").threadId);
    expect(by("Lunch").threadId).not.toBe(by("Plan").threadId);

    const t = await call(app, [["Thread/get", { accountId, ids: [by("Plan").threadId] }, "t"]]);
    expect(resp(t).args.list[0].emailIds).toEqual([by("Plan").id, by("Re: Plan").id]);
  });
});
