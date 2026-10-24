import type { Role } from "@s8s/shared";

/** Who is calling the JMAP API. Set on the Hono context by `jmapAuth`. */
export interface Principal {
  userId: string;
  /** The user's login email (== primary mailbox address). */
  email: string;
  /** JMAP accountIds this user may access (D1 `mail_account.owner_user_id`). */
  accountIds: string[];
}

export interface SessionUser {
  id: string;
  name: string;
  email: string;
  role: Role;
}

/** The signed-in session as the SPA routes see it (set by `requireSession`). */
export interface SessionInfo {
  id: string;
  impersonated: boolean;
  /** Epoch ms of the last verification of each factor in this session. */
  stamps: { password: number | null; passkey: number | null; recovery: number | null };
}

/** Hono app typing shared by all of our routes. */
export type AppEnv = {
  Bindings: Env;
  Variables: {
    /** Set by `jmapAuth`. */
    principal: Principal;
    /** Set by `requireSession` / `requireAdmin`. */
    sessionUser: SessionUser;
    sessionId: string;
    session: SessionInfo;
  };
};
