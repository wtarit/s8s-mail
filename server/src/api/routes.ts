import { createOAuthClientRequest, createUserRequest } from "@s8s/shared";
import { count } from "drizzle-orm";
import { Hono } from "hono";
import { z } from "zod";
import type { AppEnv } from "../auth/types";
import { getDb, schema } from "../db";
import { accountRoutes } from "./account-routes";
import { adminDomainRoutes } from "./admin-domain-routes";
import { adminUserRoutes } from "./admin-user-routes";
import { inviteRoutes } from "./invite-routes";
import { ApiHttpError, respondError } from "./errors";
import { checkOrigin, requireAdmin } from "./guards";
import {
  createOAuthClient,
  deleteOAuthClient,
  ensureBulwarkClient,
  listOAuthClients,
} from "./oauth-clients";
import { createUserWithAccount, sendInviteEmail } from "./users";
import { safeEqual, validate } from "./util";

export const api = new Hono<AppEnv>();

api.onError((err, c) => respondError(c, err));
api.use("*", checkOrigin);

// ------------------------------------------------------------------ bootstrap

const bootstrapRequest = z.object({
  name: z.string().trim().min(1).max(100),
  primaryAddress: createUserRequest.shape.primaryAddress,
  recoveryEmail: createUserRequest.shape.recoveryEmail,
});

/** Creates the first admin. Needs `Authorization: Bearer <BOOTSTRAP_TOKEN>`; only with zero users. */
api.post("/bootstrap", validate("json", bootstrapRequest), async (c) => {
  const secret = c.env.BOOTSTRAP_TOKEN;
  if (!secret) throw new ApiHttpError(404, "not_found", "Not found");
  const m = /^Bearer (.+)$/i.exec(c.req.header("authorization") ?? "");
  if (!m?.[1] || !(await safeEqual(m[1], secret))) {
    throw new ApiHttpError(401, "unauthorized", "Invalid bootstrap token");
  }
  const db = getDb(c.env);
  const existing = await db.select({ n: count() }).from(schema.user).get();
  if ((existing?.n ?? 0) > 0) {
    throw new ApiHttpError(409, "already_bootstrapped", "This deployment already has users");
  }
  const body = c.req.valid("json");
  const { invite } = await createUserWithAccount(
    c.env,
    { ...body, role: "admin" },
    { createDomain: true },
  );
  await ensureBulwarkClient(c.env);
  sendInviteEmail(c.env, body.recoveryEmail, body.name, invite);
  return c.json({ invite: { url: invite.url, expiresAt: invite.expiresAt } }, 201);
});

api.route("/", accountRoutes);
api.route("/", inviteRoutes);

// ------------------------------------------------------------------ admin

const admin = new Hono<AppEnv>();
admin.use("*", requireAdmin);

admin.route("/", adminUserRoutes);
admin.route("/", adminDomainRoutes);

// oauth clients ("Sign-in apps")

admin.get("/oauth-clients", async (c) => c.json({ clients: await listOAuthClients(c.env) }));

admin.post("/oauth-clients", validate("json", createOAuthClientRequest), async (c) => {
  const result = await createOAuthClient(c.env, c.req.raw.headers, c.req.valid("json"));
  return c.json(result, 201);
});

/** Idempotently (re)creates the first-party webmail client from BULWARK_CLIENT_ID / PUBLIC_URL. */
admin.post("/oauth-clients/ensure-defaults", async (c) =>
  c.json({ client: await ensureBulwarkClient(c.env) }),
);

admin.delete("/oauth-clients/:clientId", async (c) => {
  await deleteOAuthClient(c.env, c.req.param("clientId"));
  return c.json({ ok: true });
});

api.route("/admin", admin);
