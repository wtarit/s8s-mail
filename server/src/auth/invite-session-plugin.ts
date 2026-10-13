import type { BetterAuthPlugin } from "better-auth";
import { APIError, createAuthEndpoint } from "better-auth/api";
import { setSessionCookie } from "better-auth/cookies";
import { z } from "zod";

/**
 * Server-only endpoint (not routable over HTTP): creates a session for `userId` and sets the
 * Better Auth session cookie on the response. Called from our invite-accept route after the
 * one-time invite token has been consumed, with the request headers forwarded.
 */
export const inviteSession = () =>
  ({
    id: "invite-session",
    endpoints: {
      createInviteSession: createAuthEndpoint.serverOnly(
        { method: "POST", body: z.object({ userId: z.string() }) },
        async (ctx) => {
          const user = await ctx.context.internalAdapter.findUserById(ctx.body.userId);
          if (!user)
            throw APIError.from("NOT_FOUND", { code: "USER_NOT_FOUND", message: "User not found" });
          if ((user as { banned?: boolean | null }).banned) {
            throw APIError.from("FORBIDDEN", {
              code: "USER_DISABLED",
              message: "User is disabled",
            });
          }
          const session = await ctx.context.internalAdapter.createSession(user.id);
          await setSessionCookie(ctx, { session, user });
          return ctx.json({ ok: true as const, userId: user.id });
        },
      ),
    },
  }) satisfies BetterAuthPlugin;
