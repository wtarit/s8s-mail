import { Hono } from "hono";
import { handleEmail } from "./mail/ingest";

export { AccountDO } from "./store/account-do";

const app = new Hono<{ Bindings: Env }>();

app.get("/api/health", (c) => c.json({ ok: true }));

export default {
  fetch: app.fetch,
  email: handleEmail,
} satisfies ExportedHandler<Env>;
