import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { constants } from "node:fs";
import { open, unlink } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { ready, server } from "@serenity-kit/opaque";

// Deliberately manual: never create or rotate this secret during startup/build.
// Keeping it in .dev.vars lets Wrangler load it locally without exposing it on
// stdout, in a shell argument, or in a tracked configuration file.
const repoRoot = fileURLToPath(new URL("../../", import.meta.url));
const destination = fileURLToPath(new URL("../../.dev.vars", import.meta.url));
execFileSync("git", ["check-ignore", "--quiet", "--no-index", destination], {
  cwd: repoRoot,
});
const tracked = execFileSync("git", ["ls-files", "--", destination], {
  cwd: repoRoot,
  encoding: "utf8",
});
assert.equal(tracked, "", "Refusing to write an OPAQUE secret to a tracked file");

// Concurrent invocations must not append different setup keys.
const lockPath = `${destination}.opaque-setup.lock`;
const lock = await open(lockPath, "wx", 0o600);
try {
  const file = await open(
    destination,
    constants.O_CREAT | constants.O_APPEND | constants.O_RDWR | constants.O_NOFOLLOW,
    0o600,
  );
  try {
    await file.chmod(0o600);
    const current = await file.readFile("utf8");
    assert.ok(
      !/^\s*(?:export\s+)?OPAQUE_SERVER_SETUP\s*=/m.test(current),
      "OPAQUE_SERVER_SETUP already exists; refusing to rotate it",
    );
    await ready;
    const setup = server.createSetup();
    const separator = current.length > 0 && !current.endsWith("\n") ? "\n" : "";
    await file.writeFile(`${separator}OPAQUE_SERVER_SETUP=${setup}\n`, "utf8");
    await file.sync();
  } finally {
    await file.close();
  }
} finally {
  await lock.close();
  await unlink(lockPath);
}
console.info("Added OPAQUE_SERVER_SETUP to .dev.vars (mode 0600); value was not printed.");
