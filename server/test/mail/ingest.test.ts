import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { accountStub } from "../../src/store/subscribe";
import { buildRaw, seedAccount } from "../helpers/mail";
import { emails, deliver, r2Keys } from "../helpers/ingest";

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
