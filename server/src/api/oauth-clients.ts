import type { z } from "zod";
import type { createOAuthClientRequest, oauthClient } from "@s8s/shared";
import { eq } from "drizzle-orm";
import { getAuth, type Auth } from "../auth";
import { OAUTH_SCOPES, jmapResource, publicOrigin } from "../auth/config";
import { getDb, schema } from "../db";
import { ApiHttpError } from "./errors";

type OAuthClientView = z.infer<typeof oauthClient>;

function toView(row: typeof schema.oauthClient.$inferSelect): OAuthClientView {
  // Better Auth serialises arrays itself and the drizzle json column serialises again, so the
  // raw column value is a JSON string.
  let redirectUris: string[] = [];
  const raw: unknown = row.redirectUris;
  try {
    const parsed: unknown = typeof raw === "string" ? JSON.parse(raw) : raw;
    if (Array.isArray(parsed)) redirectUris = parsed.map(String);
  } catch {
    // leave empty
  }
  return {
    clientId: row.clientId,
    name: row.name ?? row.clientId,
    redirectUris,
    trusted: row.skipConsent === true,
    public: !row.clientSecret,
    createdAt: (row.createdAt ?? new Date(0)).toISOString(),
  };
}

export async function listOAuthClients(env: Env): Promise<OAuthClientView[]> {
  const rows = await getDb(env)
    .select()
    .from(schema.oauthClient)
    .orderBy(schema.oauthClient.createdAt);
  return rows.map(toView);
}

export async function getOAuthClientView(env: Env, clientId: string): Promise<OAuthClientView> {
  const row = await getDb(env)
    .select()
    .from(schema.oauthClient)
    .where(eq(schema.oauthClient.clientId, clientId))
    .get();
  if (!row) throw new ApiHttpError(404, "not_found", "OAuth client not found");
  return toView(row);
}

export async function deleteOAuthClient(env: Env, clientId: string): Promise<void> {
  const db = getDb(env);
  const row = await db
    .select({ id: schema.oauthClient.id })
    .from(schema.oauthClient)
    .where(eq(schema.oauthClient.clientId, clientId))
    .get();
  if (!row) throw new ApiHttpError(404, "not_found", "OAuth client not found");
  // tokens, consents and resource links cascade
  await db.delete(schema.oauthClient).where(eq(schema.oauthClient.clientId, clientId));
}

/** Creates a client through the provider's admin endpoint, acting as the calling admin. */
export async function createOAuthClient(
  env: Env,
  headers: Headers,
  input: z.output<typeof createOAuthClientRequest>,
): Promise<{ client: OAuthClientView; clientSecret: string | null }> {
  const auth = await getAuth(env);
  const created = await auth.api.adminCreateOAuthClient({
    headers,
    body: {
      client_name: input.name,
      redirect_uris: input.redirectUris,
      token_endpoint_auth_method: input.public ? "none" : "client_secret_basic",
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      scope: OAUTH_SCOPES.join(" "),
      skip_consent: input.trusted,
      require_pkce: true,
    },
  });
  const client = await getOAuthClientView(env, created.client_id);
  return { client, clientSecret: input.public ? null : (created.client_secret ?? null) };
}

/**
 * Idempotently creates/updates the first-party public client for the webmail (Bulwark):
 * client_id = BULWARK_CLIENT_ID, redirect `<origin>/webmail/oauth/callback`, PKCE, no secret,
 * consent skipped. Also makes sure the JMAP OAuth resource exists and is linked to the client
 * (`oauth_client_resource`), so the client may request `resource=<origin>/jmap` and receive JWT
 * access tokens.
 */
export async function ensureBulwarkClient(env: Env): Promise<OAuthClientView> {
  const clientId = env.BULWARK_CLIENT_ID;
  const redirectUri = `${publicOrigin(env)}/webmail/oauth/callback`;
  const auth = await getAuth(env);
  const ctx = await auth.$context;
  const fields = {
    name: "Webmail",
    redirectUris: [redirectUri],
    skipConsent: true,
    requirePKCE: true,
    disabled: false,
    tokenEndpointAuthMethod: "none",
    grantTypes: ["authorization_code", "refresh_token"],
    responseTypes: ["code"],
    scopes: [...OAUTH_SCOPES],
    applicationType: "web",
  };
  const existing = await ctx.adapter.findOne({
    model: "oauthClient",
    where: [{ field: "clientId", value: clientId }],
  });
  if (existing) {
    await ctx.adapter.update({
      model: "oauthClient",
      where: [{ field: "clientId", value: clientId }],
      update: { ...fields, clientSecret: null, updatedAt: new Date() },
    });
  } else {
    const now = new Date();
    await ctx.adapter.create({
      model: "oauthClient",
      data: { clientId, ...fields, createdAt: now, updatedAt: now },
      forceAllowId: true,
    });
  }
  await ensureJmapResourceLink(ctx, env, clientId);
  return getOAuthClientView(env, clientId);
}

/**
 * Idempotently makes sure the JMAP resource row exists with the configured policy (the provider
 * seeds it too, but only once per process and not after a table wipe) and that `clientId` is
 * linked to it. The provider enforces the link on authorize/token requests that carry `resource`.
 * Uses the adapter directly: the provider's admin endpoints need an admin session.
 */
async function ensureJmapResourceLink(
  ctx: Awaited<Auth["$context"]>,
  env: Env,
  clientId: string,
): Promise<void> {
  const resource = jmapResource(env);
  const where = [{ field: "identifier", value: resource.identifier }];
  const now = new Date();
  const existing = await ctx.adapter.findOne<{
    accessTokenTtl?: number | null;
    disabled?: boolean;
  }>({
    model: "oauthResource",
    where,
  });
  if (!existing) {
    await ctx.adapter.create({
      model: "oauthResource",
      data: {
        ...resource,
        dpopBoundAccessTokensRequired: false,
        disabled: false,
        policyVersion: 1,
        createdAt: now,
        updatedAt: now,
      },
    });
  } else if (existing.accessTokenTtl !== resource.accessTokenTtl || existing.disabled) {
    await ctx.adapter.update({
      model: "oauthResource",
      where,
      update: { accessTokenTtl: resource.accessTokenTtl, disabled: false, updatedAt: now },
    });
  }
  const linked = await ctx.adapter.findOne({
    model: "oauthClientResource",
    where: [
      { field: "clientId", value: clientId },
      { field: "resourceId", value: resource.identifier },
    ],
  });
  if (!linked) {
    await ctx.adapter.create({
      model: "oauthClientResource",
      data: { clientId, resourceId: resource.identifier, createdAt: now },
    });
  }
}
