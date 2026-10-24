import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { getAuth } from "../../src/auth";
import { request, resetDb, type Session } from "../helpers";
import { acceptInvite, bootstrapAdmin, userWith } from "../helpers/accounts";
import { createUser } from "../helpers/admin";
import {
  authorize,
  fetchToken,
  oauthTokens,
  refreshTokens,
  JMAP_RESOURCE,
  REDIRECT,
} from "../helpers/auth-jmap";
import {
  beginLogin,
  beginPassword,
  login,
  setPassword,
  FIRST_PASSWORD,
  NEXT_PASSWORD,
} from "../helpers/opaque";

vi.mock("../../src/send", () => ({ sendSystemMail: vi.fn(async () => {}) }));

describe("OPAQUE integration boundaries", () => {
  let ana: Session;
  beforeEach(async () => {
    await resetDb();
    const admin = await bootstrapAdmin();
    ana = await acceptInvite((await createUser(admin)).body.invite.url);
  });

  it("continues an actual signed OAuth authorization request after password login", async () => {
    const { location, verifier } = await authorize(
      { cookie: "", userId: ana.userId },
      JMAP_RESOURCE,
    );
    expect(location.pathname).toBe("/login");
    expect(location.searchParams.get("sig")).toBeTruthy();
    const pending = await beginLogin("ana@example.com");
    const completed = await request("/api/auth/opaque/login/finish", {
      json: { ...pending.body, oauth_query: location.search.slice(1) },
    });
    expect(completed.status).toBe(200);
    expect(completed.body).toMatchObject({ redirect: true });
    const callback = new URL(completed.body.url);
    expect(callback.origin + callback.pathname).toBe(REDIRECT);
    expect(callback.searchParams.get("state")).toBe("xyz");
    const code = callback.searchParams.get("code");
    expect(code).toBeTruthy();
    const token = await fetchToken(code!, verifier, REDIRECT, JMAP_RESOURCE);
    expect(token.status).toBe(200);
    expect(token.body.access_token.split(".")).toHaveLength(3);
    expect(token.body.refresh_token).toBeTruthy();
  });

  it("reports a committed password change as successful when session cleanup needs a retry", async () => {
    const other = await login();
    const adapter = (await (await getAuth(env)).$context).internalAdapter;
    const deletion = vi
      .spyOn(adapter, "deleteSessions")
      .mockRejectedValueOnce(new Error("test cleanup failure"));
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const changed = await setPassword(ana, NEXT_PASSWORD, FIRST_PASSWORD);
      expect(changed.status).toBe(200);
      expect(changed.body).toEqual({ ok: true });
      await vi.waitFor(() => expect(deletion).toHaveBeenCalledTimes(2));
      expect(errors).toHaveBeenCalledWith({
        msg: "OPAQUE password changed; expired-session cleanup retrying",
      });
      expect((await request("/api/me", { cookie: other.cookie })).status).toBe(401);
      expect((await login("ana@example.com", NEXT_PASSWORD)).status).toBe(200);
      expect((await login()).status).toBe(401);
    } finally {
      deletion.mockRestore();
      errors.mockRestore();
    }
  });

  it("kills an in-flight login handshake when the password changes underneath it", async () => {
    const pending = await beginLogin("ana@example.com");
    const replacement = await beginPassword(ana, NEXT_PASSWORD, FIRST_PASSWORD);
    const result = await request("/api/auth/opaque/password/finish", {
      cookie: ana.cookie,
      json: replacement.body,
    });
    expect(result.status).toBe(200);
    const completed = await request("/api/auth/opaque/login/finish", { json: pending.body });
    expect(completed.status).toBe(409);
    expect(completed.headers.getSetCookie().join(";")).not.toContain("session_token=");
    expect((await login("ana@example.com", NEXT_PASSWORD)).status).toBe(200);
  });

  it("revokes OAuth tokens (access and refresh) when the password changes", async () => {
    const tokens = await oauthTokens(ana, JMAP_RESOURCE);
    expect(tokens.status).toBe(200);
    await setPassword(ana, NEXT_PASSWORD, FIRST_PASSWORD);
    expect((await refreshTokens(tokens.body.refresh_token)).status).toBe(400);
    const revoked = await env.DB.prepare(
      "SELECT count(*) AS n FROM oauth_access_token WHERE revoked IS NULL AND user_id = ?",
    )
      .bind(ana.userId)
      .first<{ n: number }>();
    expect(revoked!.n).toBe(0);
  });
});

describe("OAuth continuation through the 2FA second step", () => {
  it("password (passkeyRequired) then passkey resumes the signed authorization request", async () => {
    await resetDb();
    const admin = await bootstrapAdmin();
    const user = await userWith(admin, "both");
    const { location, verifier } = await authorize(
      { cookie: "", userId: user.userId },
      JMAP_RESOURCE,
    );
    const oauth_query = location.search.slice(1);

    // Step 1: the password only starts the pending sign-in (no session, no redirect).
    const proof = await beginLogin(user.email);
    const first = await request("/api/auth/opaque/login/finish", {
      json: { ...proof.body, oauth_query },
    });
    expect(first.body).toEqual({ passkeyRequired: true, redirect: false });
    const pending = first.headers
      .getSetCookie()
      .map((c) => c.split(";")[0]!)
      .join("; ");

    // Step 2: the passkey creates the session and the OAuth continuation fires on it.
    const second = await user.passkey!.authenticate(pending, { oauth_query });
    expect(second.status).toBe(200);
    expect(second.body).toMatchObject({ redirect: true });
    const callback = new URL(second.body.url);
    expect(callback.origin + callback.pathname).toBe(REDIRECT);
    const token = await fetchToken(
      callback.searchParams.get("code")!,
      verifier,
      REDIRECT,
      JMAP_RESOURCE,
    );
    expect(token.status).toBe(200);
    expect(token.body.access_token.split(".")).toHaveLength(3);
  });

  it("a passkey alone also resumes it", async () => {
    await resetDb();
    const admin = await bootstrapAdmin();
    const user = await userWith(admin, "both");
    const { location } = await authorize({ cookie: "", userId: user.userId }, JMAP_RESOURCE);
    const oauth_query = location.search.slice(1);
    const alone = await user.passkey!.authenticate("", { oauth_query });
    expect(alone.body).toMatchObject({ redirect: true });
  });
});
