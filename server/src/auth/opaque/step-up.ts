import { APIError, createAuthEndpoint, getSessionFromCtx } from "better-auth/api";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { getDb, schema } from "../../db";
import { accountChangeNotAllowed, enrollmentSessionOnly } from "../factors/errors";
import type { SessionLike } from "../factors/policy";
import { createChallenge, consumeChallenge } from "./challenges";
import {
  challengeId,
  conflict,
  invalidCredentials,
  message,
  protocol,
  type OpaqueEnv,
} from "./common";

type Ctx = Parameters<typeof getSessionFromCtx>[0];

async function currentSession(ctx: Ctx) {
  const signedIn = await getSessionFromCtx(ctx);
  if (!signedIn) {
    throw APIError.from("UNAUTHORIZED", { code: "UNAUTHORIZED", message: "Sign in required" });
  }
  const session = signedIn.session as unknown as SessionLike;
  if (session.impersonatedBy || (signedIn.user as { banned?: boolean | null }).banned)
    accountChangeNotAllowed();
  if (session.inviteId) enrollmentSessionOnly();
  return { session, userId: signedIn.user.id };
}

/**
 * Step-up with the password: an OPAQUE login handshake bound to the CURRENT session. Success
 * stamps `password_verified_at` on that session; it starts no new session.
 */
export function stepUpEndpoints(env: OpaqueEnv) {
  return {
    stepUpPasswordStart: createAuthEndpoint(
      "/step-up/password/start",
      { method: "POST", body: z.object({ startLoginRequest: message }) },
      async (ctx) => {
        const { session, userId } = await currentSession(ctx);
        const credential = await getDb(env)
          .select()
          .from(schema.opaqueCredential)
          .where(eq(schema.opaqueCredential.userId, userId))
          .get();
        if (!credential) {
          throw APIError.from("BAD_REQUEST", {
            code: "NO_PASSWORD",
            message: "This account has no password.",
          });
        }
        const { server, serverSetup } = await protocol(env);
        try {
          const login = server.startLogin({
            serverSetup,
            userIdentifier: userId,
            registrationRecord: credential.registrationRecord,
            startLoginRequest: ctx.body.startLoginRequest,
          });
          const id = await createChallenge(
            env,
            { purpose: "stepup", userId, sessionId: session.id },
            { serverLoginState: login.serverLoginState },
          );
          return ctx.json({ challengeId: id, loginResponse: login.loginResponse });
        } catch (err) {
          if (err instanceof APIError) throw err;
          invalidCredentials();
        }
      },
    ),
    stepUpPasswordFinish: createAuthEndpoint(
      "/step-up/password/finish",
      { method: "POST", body: z.object({ challengeId, finishLoginRequest: message }) },
      async (ctx) => {
        const { session, userId } = await currentSession(ctx);
        const claimed = await consumeChallenge(env, ctx.body.challengeId, "stepup", session.id);
        if (claimed.userId !== userId) conflict();
        const { server } = await protocol(env);
        try {
          if (!claimed.state.serverLoginState) invalidCredentials();
          server.finishLogin({
            serverLoginState: claimed.state.serverLoginState,
            finishLoginRequest: ctx.body.finishLoginRequest,
          });
        } catch {
          invalidCredentials();
        }
        const stamped = await env.DB.prepare(
          `UPDATE session SET password_verified_at = ?
           WHERE id = ? AND user_id = ? AND expires_at > ? AND impersonated_by IS NULL
           AND invite_id IS NULL`,
        )
          .bind(Date.now(), session.id, userId, Date.now())
          .run();
        if (stamped.meta.changes !== 1) conflict();
        return ctx.json({ ok: true as const });
      },
    ),
  };
}
