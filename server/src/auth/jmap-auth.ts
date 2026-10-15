import { and, eq } from "drizzle-orm";
import { createMiddleware } from "hono/factory";
import { getDb, schema, type Db } from "../db";
import { AUTH_BASE_PATH, jmapResourceIdentifier, publicOrigin } from "./config";
import { getAuth } from "./index";
import { runInBackground } from "./request-context";
import type { AppEnv, Principal } from "./types";

const LAST_USED_INTERVAL_MS = 10 * 60 * 1000;
const CHALLENGE = 'Bearer, Basic realm="s8s-mail"';

function unauthorized(message = "Authentication required"): Response {
  return new Response(JSON.stringify({ type: "about:blank", status: 401, title: message }), {
    status: 401,
    headers: { "content-type": "application/json", "www-authenticate": CHALLENGE },
  });
}

interface UserRow {
  id: string;
  email: string;
  banned: boolean | null;
  banExpires: Date | null;
}

function isBanned(u: UserRow): boolean {
  if (!u.banned) return false;
  return !u.banExpires || u.banExpires.getTime() > Date.now();
}

async function loadUser(db: Db, userId: string): Promise<UserRow | undefined> {
  return db
    .select({
      id: schema.user.id,
      email: schema.user.email,
      banned: schema.user.banned,
      banExpires: schema.user.banExpires,
    })
    .from(schema.user)
    .where(eq(schema.user.id, userId))
    .get();
}

async function buildPrincipal(db: Db, user: UserRow): Promise<Principal> {
  // TODO(shared-mailboxes): also include accounts granted to this user.
  const rows = await db
    .select({ id: schema.mailAccount.id })
    .from(schema.mailAccount)
    .where(eq(schema.mailAccount.ownerUserId, user.id));
  return { userId: user.id, email: user.email, accountIds: rows.map((r) => r.id) };
}

/** True when the OAuth client exists, is enabled and is first-party (consent skipped). */
async function isTrustedClient(db: Db, clientId: string): Promise<boolean> {
  const row = await db
    .select({ disabled: schema.oauthClient.disabled, skipConsent: schema.oauthClient.skipConsent })
    .from(schema.oauthClient)
    .where(eq(schema.oauthClient.clientId, clientId))
    .get();
  return !!row && row.skipConsent === true && !row.disabled;
}

/** Opaque access token (what the provider issues unless a `resource` is requested). */
async function userIdFromOpaqueToken(env: Env, db: Db, token: string): Promise<string | null> {
  // Only tokens issued to first-party ("trusted") clients may reach mail: an SSO app registered
  // for sign-in must not be able to read it. Tokens are stored as base64url(sha256(token)).
  const { defaultKeyHasher } = await import("@better-auth/api-key");
  const row = await db
    .select({ clientId: schema.oauthAccessToken.clientId, userId: schema.oauthAccessToken.userId })
    .from(schema.oauthAccessToken)
    .where(eq(schema.oauthAccessToken.token, await defaultKeyHasher(token)))
    .get();
  if (!row?.userId || !(await isTrustedClient(db, row.clientId))) return null;

  // The provider's own validation: expiry, revocation, client enabled, session alive.
  // In-process call, no HTTP self-fetch.
  const auth = await getAuth(env);
  try {
    const info = await auth.api.oauth2UserInfo({
      headers: new Headers({ authorization: `Bearer ${token}` }),
    });
    return info?.sub === row.userId ? row.userId : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------------------------
// JWT access tokens. Better Auth signs them; this path only verifies, locally, with two small
// per-isolate caches. It must not import or initialise Better Auth (that is the point: the opaque
// path costs ~8 ms CPU on Workers Free, mostly D1 reads through Better Auth's adapter).
// ---------------------------------------------------------------------------------------------

/** Never reload the signing keys more often than this because of an unknown `kid`. */
const JWKS_MIN_RELOAD_MS = 30 * 1000;
/** Reload the key set at least this often, so a deleted key stops verifying. */
const JWKS_MAX_AGE_MS = 10 * 60 * 1000;
/** Better Auth's jwt() default: a key keeps verifying this long after its `expires_at`. */
const JWKS_GRACE_MS = 30 * 24 * 60 * 60 * 1000;
const TRUSTED_CLIENT_TTL_MS = 60 * 1000;

interface SigningKey {
  key: CryptoKey | Uint8Array;
  /** Verification stops after this instant (null: never expires). */
  notAfter: number | null;
}
interface KeySet {
  loadedAt: number;
  keys: Map<string, SigningKey>;
}

let keySet: KeySet | null = null;
let keySetLoad: Promise<KeySet> | null = null;
const trustedClients = new Map<string, { trusted: boolean; until: number }>();

/** Drops the per-isolate JWT caches. For tests. */
export function resetJmapAuthCaches(): void {
  keySet = null;
  keySetLoad = null;
  trustedClients.clear();
}

/** Reads the public signing keys (public JWK only, never the private key) from the jwks table. */
async function loadKeySet(db: Db): Promise<KeySet> {
  const { importJWK } = await import("jose");
  const rows = await db
    .select({
      id: schema.jwks.id,
      publicKey: schema.jwks.publicKey,
      alg: schema.jwks.alg,
      expiresAt: schema.jwks.expiresAt,
    })
    .from(schema.jwks);
  const keys = new Map<string, SigningKey>();
  for (const row of rows) {
    if ((row.alg ?? "EdDSA") !== "EdDSA") continue;
    try {
      // The stored public key is the bare JWK JSON ({kty, crv, x}); the id is the JWT `kid`.
      const key = await importJWK(JSON.parse(row.publicKey), "EdDSA");
      keys.set(row.id, {
        key,
        notAfter: row.expiresAt ? row.expiresAt.getTime() + JWKS_GRACE_MS : null,
      });
    } catch {
      // skip a malformed row
    }
  }
  return { loadedAt: Date.now(), keys };
}

function reloadKeySet(db: Db): Promise<KeySet> {
  keySetLoad ??= loadKeySet(db)
    .then((loaded) => {
      // An empty set is not cached: the first login mints the first key (no tokens exist before).
      keySet = loaded.keys.size ? loaded : null;
      return loaded;
    })
    .finally(() => {
      keySetLoad = null;
    });
  return keySetLoad;
}

/** The verification key for a `kid`; reloads the set once if it is unknown (key rotation). */
async function signingKeyFor(db: Db, kid: string): Promise<SigningKey | undefined> {
  const now = Date.now();
  let current = keySet;
  if (!current || now - current.loadedAt >= JWKS_MAX_AGE_MS) current = await reloadKeySet(db);
  else if (!current.keys.has(kid) && now - current.loadedAt >= JWKS_MIN_RELOAD_MS)
    current = await reloadKeySet(db);
  const found = current.keys.get(kid);
  return found && (found.notAfter === null || found.notAfter > Date.now()) ? found : undefined;
}

/** `isTrustedClient`, cached per isolate for a minute (revoking trust takes up to that long). */
async function isTrustedClientCached(db: Db, clientId: string): Promise<boolean> {
  const hit = trustedClients.get(clientId);
  if (hit && hit.until > Date.now()) return hit.trusted;
  const trusted = await isTrustedClient(db, clientId);
  trustedClients.set(clientId, { trusted, until: Date.now() + TRUSTED_CLIENT_TTL_MS });
  return trusted;
}

/** JWT access token (issued when a client requests `resource=<origin>/jmap`). */
async function userIdFromJwt(env: Env, db: Db, token: string): Promise<string | null> {
  const origin = publicOrigin(env);
  const { jwtVerify, decodeProtectedHeader } = await import("jose");
  let kid: string | undefined;
  try {
    const header = decodeProtectedHeader(token);
    if (header.alg === "EdDSA") kid = header.kid;
  } catch {
    return null;
  }
  if (typeof kid !== "string") return null;
  const signing = await signingKeyFor(db, kid);
  if (!signing) return null;
  let payload;
  try {
    ({ payload } = await jwtVerify(token, signing.key, {
      issuer: `${origin}${AUTH_BASE_PATH}`,
      audience: jmapResourceIdentifier(env),
      algorithms: ["EdDSA"],
    }));
  } catch {
    return null;
  }
  const clientId = typeof payload.azp === "string" ? payload.azp : undefined;
  if (!payload.sub || !clientId || !(await isTrustedClientCached(db, clientId))) return null;
  if (typeof payload.sid === "string") {
    const session = await db
      .select({ expiresAt: schema.session.expiresAt })
      .from(schema.session)
      .where(eq(schema.session.id, payload.sid))
      .get();
    if (!session || session.expiresAt.getTime() <= Date.now()) return null;
  }
  return payload.sub;
}

/** Bearer: an access token issued by our OAuth provider, validated in-process. */
async function authenticateBearer(env: Env, db: Db, token: string): Promise<Principal | null> {
  const userId =
    token.split(".").length === 3
      ? await userIdFromJwt(env, db, token)
      : await userIdFromOpaqueToken(env, db, token);
  if (!userId) return null;
  const user = await loadUser(db, userId);
  if (!user || isBanned(user)) return null;
  return buildPrincipal(db, user);
}

/** Basic: username = login email, password = an app password (api-key, SHA-256 lookup). */
async function authenticateBasic(db: Db, encoded: string): Promise<Principal | null> {
  let decoded: string;
  try {
    decoded = new TextDecoder().decode(Uint8Array.from(atob(encoded), (c) => c.charCodeAt(0)));
  } catch {
    return null;
  }
  const sep = decoded.indexOf(":");
  if (sep < 1) return null;
  const username = decoded.slice(0, sep).trim().toLowerCase();
  const password = decoded.slice(sep + 1);
  if (!password) return null;

  // Read-only lookup with the api-key plugin's own hash. We deliberately do not call
  // auth.api.verifyApiKey: it writes usage counters to D1 on every call (100k writes/day on Free).
  const { defaultKeyHasher } = await import("@better-auth/api-key");
  const hashed = await defaultKeyHasher(password);
  const key = await db
    .select({
      referenceId: schema.apikey.referenceId,
      enabled: schema.apikey.enabled,
      expiresAt: schema.apikey.expiresAt,
      id: schema.apikey.id,
      lastRequest: schema.apikey.lastRequest,
    })
    .from(schema.apikey)
    .where(and(eq(schema.apikey.key, hashed), eq(schema.apikey.configId, "default")))
    .get();
  if (!key || key.enabled === false) return null;
  if (key.expiresAt && key.expiresAt.getTime() <= Date.now()) return null;

  const user = await loadUser(db, key.referenceId);
  if (!user || isBanned(user) || user.email.toLowerCase() !== username) return null;

  // "Last used" for the account page: at most one D1 write per key per 10 minutes.
  const now = Date.now();
  if (!key.lastRequest || now - key.lastRequest.getTime() > LAST_USED_INTERVAL_MS) {
    runInBackground(
      db
        .update(schema.apikey)
        .set({ lastRequest: new Date(now) })
        .where(eq(schema.apikey.id, key.id)),
    );
  }
  return buildPrincipal(db, user);
}

/**
 * Hono middleware for the JMAP API. Accepts `Authorization: Bearer <access token>` (our OAuth
 * provider) or `Authorization: Basic base64(email:app-password)`. Sets `c.var.principal`, or
 * answers 401 with `WWW-Authenticate: Bearer, Basic realm="s8s-mail"`.
 *
 * Usage: `jmap.use("*", jmapAuth)` then `c.get("principal")`.
 */
export const jmapAuth = createMiddleware<AppEnv>(async (c, next) => {
  const header = c.req.header("authorization");
  if (!header) return unauthorized();
  const space = header.indexOf(" ");
  const scheme = (space === -1 ? header : header.slice(0, space)).toLowerCase();
  const credentials = space === -1 ? "" : header.slice(space + 1).trim();
  if (!credentials) return unauthorized();

  const db = getDb(c.env);
  let principal: Principal | null = null;
  try {
    if (scheme === "bearer") principal = await authenticateBearer(c.env, db, credentials);
    else if (scheme === "basic") principal = await authenticateBasic(db, credentials);
  } catch (err) {
    console.error("jmapAuth failed", err instanceof Error ? err.message : err);
    return unauthorized();
  }
  if (!principal) return unauthorized("Invalid credentials");
  c.set("principal", principal);
  await next();
});
