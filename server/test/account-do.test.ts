import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

describe("AccountDO", () => {
  it("runs its drizzle migrations on startup", async () => {
    const stub = env.ACCOUNT.get(env.ACCOUNT.idFromName("test-account"));
    expect(await stub.listTables()).toContain("meta");
  });

  it("reads and writes through the placeholder table", async () => {
    const stub = env.ACCOUNT.get(env.ACCOUNT.idFromName("test-account-2"));
    expect(await stub.getMeta("k")).toBeNull();
    await stub.setMeta("k", "v1");
    await stub.setMeta("k", "v2");
    expect(await stub.getMeta("k")).toBe("v2");
  });
});
