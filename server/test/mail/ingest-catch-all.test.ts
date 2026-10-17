import { describe, expect, it } from "vitest";
import { buildRaw } from "../helpers/mail";
import { setupAccount } from "../helpers/jmap";
import { deliver, downloadText, getEmails, searchIds, setCatchAll } from "../helpers/ingest";

describe("catch-all", () => {
  it("rejects unknown local parts when no catch-all is set", async () => {
    const { app, accountId } = await setupAccount("ca-off", ["real@catch-off.example.com"]);
    const { setReject } = await deliver("nobody@catch-off.example.com", buildRaw());
    expect(setReject).toHaveBeenCalledWith("5.1.1 Recipient address rejected");
    expect(await searchIds(app, accountId)).toHaveLength(0);
  });

  it("delivers unknown local parts to the catch-all account, message unchanged", async () => {
    const { app, accountId } = await setupAccount("ca-on", ["boss@catch-on.example.com"]);
    await setCatchAll("catch-on.example.com", "boss@catch-on.example.com");
    const raw = buildRaw({ to: "Anything@Catch-On.example.com", subject: "Caught" });

    const { setReject } = await deliver("Anything+tag@Catch-On.example.com", raw);
    expect(setReject).not.toHaveBeenCalled();
    const [email] = await getEmails(app, accountId, ["subject", "blobId"]);
    expect(email!.subject).toBe("Caught");
    // the stored message still shows the original recipient
    expect(await downloadText(app, accountId, email!.blobId)).toContain(
      "To: Anything@Catch-On.example.com",
    );
  });

  it("exact match and +tag routing win over the catch-all", async () => {
    const ana = await setupAccount("ca-exact", ["ana@catch-exact.example.com"]);
    const boss = await setupAccount("ca-exact-boss", ["boss@catch-exact.example.com"]);
    await setCatchAll("catch-exact.example.com", "boss@catch-exact.example.com");

    await deliver("ana@catch-exact.example.com", buildRaw());
    await deliver("ana+news@catch-exact.example.com", buildRaw());
    expect(await searchIds(ana.app, ana.accountId)).toHaveLength(2);
    expect(await searchIds(boss.app, boss.accountId)).toHaveLength(0);

    await deliver("stranger@catch-exact.example.com", buildRaw());
    expect(await searchIds(boss.app, boss.accountId)).toHaveLength(1);
  });

  it("can point at an alias or an address on another served domain", async () => {
    const x = await setupAccount("ca-x", ["x@catch-x.example.com", "x-alias@other-x.example.com"]);
    await setCatchAll("catch-x.example.com", "x-alias@other-x.example.com");
    await setupAccount("ca-x-user", ["u@catch-x.example.com"]);
    const { setReject } = await deliver("whoever@catch-x.example.com", buildRaw());
    expect(setReject).not.toHaveBeenCalled();
    expect(await searchIds(x.app, x.accountId)).toHaveLength(1);
  });

  it("never applies to domains we do not serve", async () => {
    const { app, accountId } = await setupAccount("ca-unserved", [
      "boss@catch-unserved.example.com",
    ]);
    await setCatchAll("catch-unserved.example.com", "boss@catch-unserved.example.com");
    const { setReject } = await deliver("anyone@not-served.example.com", buildRaw());
    expect(setReject).toHaveBeenCalledWith("5.1.1 Recipient address rejected");
    expect(await searchIds(app, accountId)).toHaveLength(0);
  });
});
