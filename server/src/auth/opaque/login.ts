import { APIError, createAuthEndpoint, formCsrfMiddleware } from "better-auth/api";
import { setSessionCookie } from "better-auth/cookies";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { getDb, schema } from "../../db";
import { clearPendingCookie, pendingTokenFrom, setPendingCookie } from "../factors/cookies";
import { resolveSignIn } from "../factors/sign-in";
import { createChallenge, consumeChallenge } from "./challenges";
import {
  challengeId,
  invalidCredentials,
  message,
  oauthQuery,
  protocol,
  type OpaqueEnv,
} from "./common";

export function loginEndpoints(env: OpaqueEnv) {
  return {
    opaqueLoginStart: createAuthEndpoint(
      "/opaque/login/start",
      {
        method: "POST",
        use: [formCsrfMiddleware],
        body: z.object({ email: z.email().max(254), startLoginRequest: message, ...oauthQuery }),
      },
      async (ctx) => {
        const email = ctx.body.email.toLowerCase();
        const row = await getDb(env)
          .select({
            userId: schema.user.id,
            registrationRecord: schema.opaqueCredential.registrationRecord,
          })
          .from(schema.user)
          .leftJoin(schema.opaqueCredential, eq(schema.user.id, schema.opaqueCredential.userId))
          .where(eq(schema.user.email, email))
          .get();
        const { server, serverSetup } = await protocol(env);
        try {
          // Unknown users and users without a password get a fake (but well-formed) response.
          const login = server.startLogin({
            serverSetup,
            userIdentifier: row?.userId ?? email,
            registrationRecord: row?.registrationRecord ?? null,
            startLoginRequest: ctx.body.startLoginRequest,
          });
          const id = await createChallenge(
            env,
            { purpose: "login", userId: row?.userId ?? null, sessionId: null },
            { serverLoginState: login.serverLoginState },
          );
          return ctx.json({ challengeId: id, loginResponse: login.loginResponse });
        } catch (err) {
          if (err instanceof APIError) throw err;
          invalidCredentials();
        }
      },
    ),
    /**
     * A verified password signs in a user without a passkey. For a 2FA user it creates NO session:
     * it answers `passkeyRequired` and leaves a pending sign-in (HttpOnly cookie); passkey
     * authentication then creates the session. During recovery the pending recovery link stands
     * in for the passkey and the session is created here.
     */
    opaqueLoginFinish: createAuthEndpoint(
      "/opaque/login/finish",
      {
        method: "POST",
        use: [formCsrfMiddleware],
        body: z.object({ challengeId, finishLoginRequest: message, ...oauthQuery }),
      },
      async (ctx) => {
        const claimed = await consumeChallenge(env, ctx.body.challengeId, "login");
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
        if (!claimed.userId) invalidCredentials();
        const user = await ctx.context.internalAdapter.findUserById(claimed.userId);
        if (!user || !user.emailVerified || (user as { banned?: boolean | null }).banned)
          invalidCredentials();
        ctx.setHeader("Cache-Control", "no-store");

        const outcome = await resolveSignIn(
          env,
          user.id,
          { password: Date.now() },
          pendingTokenFrom(ctx),
        );
        if (!outcome.done) {
          if (outcome.pendingToken) setPendingCookie(ctx, outcome.pendingToken);
          return ctx.json({ passkeyRequired: true as const, redirect: false as const });
        }
        const session = await ctx.context.internalAdapter.createSession(
          user.id,
          false,
          outcome.stamps,
        );
        await setSessionCookie(ctx, { session, user });
        clearPendingCookie(ctx);
        return ctx.json({
          user: { id: user.id, name: user.name, email: user.email },
          redirect: false as const,
        });
      },
    ),
  };
}
