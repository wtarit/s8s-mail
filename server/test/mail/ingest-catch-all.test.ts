import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { buildRaw, seedAccount } from "../helpers/mail";
import { emails, deliver, setCatchAll } from "../helpers/ingest";

describe("catch-all", () => {
  it("rejects unknown local parts when no catch-all is set", async () => {
    await seedAccount("ca-off", ["real@catch-off.example.com"]);
    const { setReject } = await deliver("nobody@catch-off.example.com", buildRaw());
    expect(setReject).toHaveBeenCalledWith("5.1.1 Recipient address rejected");
    expect(await emails("ca-off")).toHaveLength(0);
  });

  it("delivers unknown local parts to the catch-all account, message unchanged", async () => {
    await seedAccount("ca-on", ["boss@catch-on.example.com"]);
    await setCatchAll("catch-on.example.com", "boss@catch-on.example.com");
    const raw = buildRaw({ to: "Anything@Catch-On.example.com", subject: "Caught" });

    const { setReject } = await deliver("Anything+tag@Catch-On.example.com", raw);
    expect(setReject).not.toHaveBeenCalled();
    const [row] = await emails("ca-on");
    expect(row).toMatchObject({ subject: "Caught" });
    // the stored message still shows the original recipient
    const obj = await env.BLOBS.get(`ca-on/${row!.blob_id}`);
    expect(await obj!.text()).toContain("To: Anything@Catch-On.example.com");
  });

  it("exact match and +tag routing win over the catch-all", async () => {
    await seedAccount("ca-exact", ["ana@catch-exact.example.com"]);
    await seedAccount("ca-exact-boss", ["boss@catch-exact.example.com"]);
    await setCatchAll("catch-exact.example.com", "boss@catch-exact.example.com");

    await deliver("ana@catch-exact.example.com", buildRaw());
    await deliver("ana+news@catch-exact.example.com", buildRaw());
    expect(await emails("ca-exact")).toHaveLength(2);
    expect(await emails("ca-exact-boss")).toHaveLength(0);

    await deliver("stranger@catch-exact.example.com", buildRaw());
    expect(await emails("ca-exact-boss")).toHaveLength(1);
  });

  it("can point at an alias or an address on another served domain", async () => {
    await seedAccount("ca-x", ["x@catch-x.example.com", "x-alias@other-x.example.com"]);
    await setCatchAll("catch-x.example.com", "x-alias@other-x.example.com");
    await seedAccount("ca-x-user", ["u@catch-x.example.com"]);
    const { setReject } = await deliver("whoever@catch-x.example.com", buildRaw());
    expect(setReject).not.toHaveBeenCalled();
    expect(await emails("ca-x")).toHaveLength(1);
  });

  it("never applies to domains we do not serve", async () => {
    await seedAccount("ca-unserved", ["boss@catch-unserved.example.com"]);
    await setCatchAll("catch-unserved.example.com", "boss@catch-unserved.example.com");
    const { setReject } = await deliver("anyone@not-served.example.com", buildRaw());
    expect(setReject).toHaveBeenCalledWith("5.1.1 Recipient address rejected");
    expect(await emails("ca-unserved")).toHaveLength(0);
  });
});
