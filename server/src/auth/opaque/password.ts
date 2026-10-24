import { APIError, createAuthEndpoint } from "better-auth/api";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { getDb, schema } from "../../db";
import { commitFirstFactor } from "../enrollment/commit";
import { currentPasswordRequired } from "../factors/errors";
import { requireAccountChange } from "../factors/guard";
import { createChallenge, consumeChallenge } from "./challenges";
import {
  challengeId,
  conflict,
  invalidCredentials,
  message,
  oauthQuery,
  protocol,
  type OpaqueEnv,
} from "./common";
import { replacePassword } from "./password-store";

const invalidRequest = () =>
  APIError.from("BAD_REQUEST", {
    code: "OPAQUE_INVALID_REQUEST",
    message: "Invalid authentication request.",
  });

/**
 * Set or change the password. One OPAQUE exchange carries the registration of the new password
 * and (when the user has a password) the proof of the current one, which counts as a password
 * verification for the account-change gate. The proof is mandatory except for a first password,
 * during recovery (the link stands in for it) and while enrolling from an invite.
 */
export function passwordEndpoints(env: OpaqueEnv) {
  return {
    opaquePasswordStart: createAuthEndpoint(
      "/opaque/password/start",
      {
        method: "POST",
        body: z.object({
          registrationRequest: message,
          startLoginRequest: message.optional(),
          ...oauthQuery,
        }),
      },
      async (ctx) => {
        const proof = !!ctx.body.startLoginRequest;
        const change = await requireAccountChange(env, ctx, {
          enrollment: true,
          proven: proof ? ["password"] : [],
        });
        const { user, session } = change;
        const credential = await getDb(env)
          .select()
          .from(schema.opaqueCredential)
          .where(eq(schema.opaqueCredential.userId, user.id))
          .get();
        const proofRequired = !!credential && change.status.currentPasswordRequired;
        if (proofRequired && !proof) currentPasswordRequired();
        const { server, serverSetup } = await protocol(env);
        try {
          const registration = server.createRegistrationResponse({
            serverSetup,
            userIdentifier: user.id,
            registrationRequest: ctx.body.registrationRequest,
          });
          const login =
            credential && ctx.body.startLoginRequest
              ? server.startLogin({
                  serverSetup,
                  userIdentifier: user.id,
                  registrationRecord: credential.registrationRecord,
                  startLoginRequest: ctx.body.startLoginRequest,
                })
              : undefined;
          const id = await createChallenge(
            env,
            { purpose: "password", userId: user.id, sessionId: session.id },
            { serverLoginState: login?.serverLoginState, proofRequired },
          );
          return ctx.json({
            challengeId: id,
            registrationResponse: registration.registrationResponse,
            ...(login ? { loginResponse: login.loginResponse } : {}),
          });
        } catch (err) {
          if (err instanceof APIError) throw err;
          throw invalidRequest();
        }
      },
    ),
    opaquePasswordFinish: createAuthEndpoint(
      "/opaque/password/finish",
      {
        method: "POST",
        body: z.object({
          challengeId,
          registrationRecord: z.string().regex(/^[A-Za-z0-9_-]{256}$/),
          finishLoginRequest: message.optional(),
          ...oauthQuery,
        }),
      },
      async (ctx) => {
        // Optimistic gate (assumes the proof is valid) so a bad session fails before consuming.
        const pre = await requireAccountChange(env, ctx, {
          enrollment: true,
          proven: ["password"],
        });
        const { user, session } = pre;
        const claimed = await consumeChallenge(env, ctx.body.challengeId, "password", session.id);
        if (claimed.userId !== user.id || claimed.sessionId !== session.id) conflict();
        if (claimed.state.serverLoginState) {
          if (!ctx.body.finishLoginRequest) invalidCredentials();
          const { server } = await protocol(env);
          try {
            server.finishLogin({
              serverLoginState: claimed.state.serverLoginState,
              finishLoginRequest: ctx.body.finishLoginRequest,
            });
          } catch {
            invalidCredentials();
          }
        } else {
          if (claimed.state.proofRequired) conflict();
          // Recovery without a proof: the link must still be fresh now.
          await requireAccountChange(env, ctx, { enrollment: true });
        }
        const revoked = pre.enrollment
          ? await commitFirstFactor(env, {
              kind: "password",
              userId: user.id,
              sessionId: session.id,
              inviteId: session.inviteId!,
              registrationRecord: ctx.body.registrationRecord,
            })
          : await replacePassword(env, {
              userId: user.id,
              sessionId: session.id,
              registrationRecord: ctx.body.registrationRecord,
            });
        if (revoked.length) {
          try {
            await ctx.context.internalAdapter.deleteSessions(revoked);
          } catch {
            // The change already committed and the old sessions are expired. A cleanup
            // failure must not tell the user their password change failed.
            console.error({ msg: "OPAQUE password changed; expired-session cleanup retrying" });
            await ctx.context.runInBackgroundOrAwait(
              ctx.context.internalAdapter.deleteSessions(revoked).catch(() => {
                console.error({ msg: "OPAQUE expired-session cleanup retry failed" });
              }),
            );
          }
        }
        return ctx.json({ ok: true as const });
      },
    ),
  };
}
