import type { BetterAuthPlugin } from "better-auth";
import { APIError, createAuthEndpoint } from "better-auth/api";
import { setSessionCookie } from "better-auth/cookies";
import type { passkey } from "@better-auth/passkey";
import { z } from "zod";
import type { OpaqueEnv } from "../opaque/common";
import { requireAccountChange } from "../factors/guard";
import { commitFirstFactor, type PasskeyRow } from "./commit";

/** Thrown from the passkey plugin's `afterVerification` once the batch committed (see below). */
export const PASSKEY_COMMITTED = "S8S_PASSKEY_COMMITTED";

/**
 * Server-only endpoint (not routable over HTTP): opens an ENROLLMENT-ONLY session for the invite's
 * user and sets the session cookie. Opening a link does not use the invite up; the session ends
 * with the invite (at the latest) and can only save the first factor.
 */
export const inviteSession = () =>
  ({
    id: "invite-session",
    endpoints: {
      createInviteSession: createAuthEndpoint.serverOnly(
        {
          method: "POST",
          body: z.object({ userId: z.string(), inviteId: z.string(), expiresAt: z.number() }),
        },
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
          const session = await ctx.context.internalAdapter.createSession(
            user.id,
            false,
            { inviteId: ctx.body.inviteId, expiresAt: new Date(ctx.body.expiresAt) },
            true,
          );
          await setSessionCookie(ctx, { session, user });
          return ctx.json({ ok: true as const, userId: user.id });
        },
      ),
    },
  }) satisfies BetterAuthPlugin;

/**
 * The passkey plugin writes the passkey row itself, after `afterVerification`. For an enrollment
 * session we must save it INSIDE the invite batch instead, so we commit there and then throw
 * `PASSKEY_COMMITTED`; the after hook in `factors/hooks.ts` turns that into the success response
 * and the plugin never inserts a second row. Ordinary add-passkey calls pass through untouched.
 */
type AfterVerification = NonNullable<
  NonNullable<NonNullable<Parameters<typeof passkey>[0]>["registration"]>["afterVerification"]
>;

export function passkeyRegistration(env: OpaqueEnv): AfterVerification {
  return async ({ ctx, verification, clientData }) => {
    const change = await requireAccountChange(env, ctx, { enrollment: true });
    if (!change.enrollment) return;
    const info = verification.registrationInfo!;
    const passkey: PasskeyRow = {
      id: crypto.randomUUID(),
      name: (ctx.body as { name?: string } | undefined)?.name?.trim() || null,
      publicKey: btoa(String.fromCharCode(...info.credential.publicKey)),
      credentialID: info.credential.id,
      counter: info.credential.counter,
      deviceType: info.credentialDeviceType,
      backedUp: info.credentialBackedUp,
      transports: clientData.response?.transports?.join(",") ?? "",
      createdAt: Date.now(),
      aaguid: info.aaguid ?? null,
    };
    const revoked = await commitFirstFactor(env, {
      kind: "passkey",
      userId: change.user.id,
      sessionId: change.session.id,
      inviteId: change.session.inviteId!,
      passkey,
    });
    if (revoked.length) {
      await ctx.context.internalAdapter.deleteSessions(revoked).catch(() => {
        console.error({ msg: "enrollment: expired-session cleanup failed" });
      });
    }
    throw new APIError("OK", { code: PASSKEY_COMMITTED, message: "Passkey saved.", passkey });
  };
}
