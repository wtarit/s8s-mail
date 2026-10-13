/**
 * JMAP API (RFC 8620 core, RFC 8621 mail + submission).
 *
 * Mount in `src/index.ts` (the auth middleware supplies `c.var.principal`):
 *
 *   app.get("/.well-known/jmap", wellKnownJmap);
 *   app.use("/jmap/*", jmapAuth);
 *   app.route("/jmap", jmapApp);
 */
import { Hono, type Context } from "hono";
import { handleApi } from "./api";
import { handleDownload, handleUpload } from "./blobs";
import { handleEventSource } from "./eventsource";
import { buildSession } from "./session";
import type { JmapEnv } from "./types";

export type { Principal } from "./types";

export const jmapApp = new Hono<JmapEnv>({ strict: false });

jmapApp.get("/session", async (c) => c.json(await buildSession(c.env, c.get("principal"))));
jmapApp.post("/api", handleApi);
// Both spellings: the parent app may be in strict mode (trailing slash significant).
jmapApp.post("/upload/:accountId", handleUpload);
jmapApp.post("/upload/:accountId/", handleUpload);
jmapApp.get("/download/:accountId/:blobId/:name", handleDownload);
jmapApp.get("/eventsource", handleEventSource);

/** `GET /.well-known/jmap` -> the session resource (RFC 8620 §2.2). */
export function wellKnownJmap(c: Context): Response {
  return c.redirect("/jmap/session", 302);
}
