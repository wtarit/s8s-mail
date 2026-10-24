import { and, eq, gt, lt } from "drizzle-orm";
import { getDb, schema } from "../../db";
import { CHALLENGE_TTL, conflict, type OpaqueEnv } from "./common";

export interface Challenge {
  id: string;
  purpose: "login" | "password" | "stepup";
  userId: string | null;
  sessionId: string | null;
  expiresAt: number;
}
export interface ChallengeState {
  serverLoginState?: string;
  /** Password change: the current-password proof is mandatory at completion. */
  proofRequired?: boolean;
}
const encode = (bytes: ArrayBuffer | Uint8Array) =>
  btoa(String.fromCharCode(...new Uint8Array(bytes)));
const decode = (value: string) => Uint8Array.from(atob(value), (c) => c.charCodeAt(0));
const encoder = new TextEncoder();
// All security bindings are authenticated with the state, including its database ID.
const aad = (c: Challenge) =>
  encoder.encode(JSON.stringify([c.id, c.purpose, c.userId, c.sessionId, c.expiresAt]));
async function key(env: OpaqueEnv) {
  const raw = await crypto.subtle.digest(
    "SHA-256",
    encoder.encode("s8s:opaque:challenge:v1:" + env.BETTER_AUTH_SECRET),
  );
  return crypto.subtle.importKey("raw", raw, "AES-GCM", false, ["encrypt", "decrypt"]);
}

export async function createChallenge(
  env: OpaqueEnv,
  fields: Omit<Challenge, "id" | "expiresAt">,
  state: ChallengeState,
) {
  const challenge: Challenge = {
    id: crypto.randomUUID(),
    ...fields,
    expiresAt: Date.now() + CHALLENGE_TTL,
  };
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv, additionalData: aad(challenge) },
    await key(env),
    encoder.encode(JSON.stringify(state)),
  );
  const encryptedState = encode(iv) + "." + encode(ciphertext);
  const db = getDb(env);
  await db.batch([
    db.delete(schema.opaqueChallenge).where(lt(schema.opaqueChallenge.expiresAt, Date.now())),
    db.insert(schema.opaqueChallenge).values({ ...challenge, encryptedState }),
  ]);
  return challenge.id;
}

/** DELETE RETURNING is the cross-isolate, single-winner completion boundary. */
export async function consumeChallenge(
  env: OpaqueEnv,
  id: string,
  purpose: Challenge["purpose"],
  sessionId?: string,
) {
  const row = await getDb(env)
    .delete(schema.opaqueChallenge)
    .where(
      and(
        eq(schema.opaqueChallenge.id, id),
        eq(schema.opaqueChallenge.purpose, purpose),
        gt(schema.opaqueChallenge.expiresAt, Date.now()),
        sessionId ? eq(schema.opaqueChallenge.sessionId, sessionId) : undefined,
      ),
    )
    .returning()
    .get();
  if (!row) conflict();
  const { encryptedState, ...challenge } = row;
  try {
    const [iv, ciphertext] = encryptedState.split(".");
    if (!iv || !ciphertext) conflict();
    const plain = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: decode(iv), additionalData: aad(challenge) },
      await key(env),
      decode(ciphertext),
    );
    return { ...challenge, state: JSON.parse(new TextDecoder().decode(plain)) as ChallengeState };
  } catch {
    conflict();
  }
}
