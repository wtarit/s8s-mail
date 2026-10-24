import { env } from "cloudflare:workers";
import { client, ready } from "../../src/auth/.generated/opaque-worker.mjs";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { cookieFrom, request, resetDb, type Session } from "../helpers";
import { ageStamps, bootstrapAdmin, stampsOf, userWith, type TestUser } from "../helpers/accounts";
import { FIRST_PASSWORD, login, stepUpPassword } from "../helpers/opaque";

vi.mock("../../src/send", () => ({ sendSystemMail: vi.fn(async () => {}) }));

const MINUTES = 60_000;
const sessionCount = async () =>
  (await env.DB.prepare("SELECT count(*) AS n FROM session").first<{ n: number }>())!.n;
const createAppPassword = (cookie: string) =>
  request("/api/auth/api-key/create", { cookie, json: { name: "k" } });

describe("step-up for an existing session", () => {
  let admin: Session;
  let ana: TestUser;
  beforeEach(async () => {
    await resetDb();
    admin = await bootstrapAdmin();
    ana = await userWith(admin, "both");
    await ageStamps(ana.session.cookie, 6 * MINUTES);
  });

  it("password: stamps the CURRENT session, starts no new one, leaves other sessions alone", async () => {
    const other = cookieFrom((await ana.passkey!.authenticate()).headers);
    const before = await sessionCount();
    const res = await stepUpPassword(ana.session, FIRST_PASSWORD);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
    expect(res.headers.get("cache-control")).toContain("no-store");
    expect(cookieFrom(res.headers)).not.toContain("session_token");
    expect(await sessionCount()).toBe(before);
    const stamps = await stampsOf(ana.session.cookie);
    expect(Date.now() - Date.parse(stamps.password!)).toBeLessThan(MINUTES);
    expect(Date.parse(stamps.passkey!)).toBeLessThan(Date.now() - 5 * MINUTES);
    expect((await request("/api/me", { cookie: other })).status).toBe(200);
  });

  it("one factor does not stand in for the other: the passkey is still named as stale", async () => {
    await stepUpPassword(ana.session, FIRST_PASSWORD);
    const res = await createAppPassword(ana.session.cookie);
    expect(res.body).toMatchObject({ code: "REAUTHENTICATION_REQUIRED", stale: ["passkey"] });
    expect((await ana.passkey!.authenticate(ana.session.cookie)).status).toBe(200);
    expect((await createAppPassword(ana.session.cookie)).status).toBe(200);
  });

  it("a wrong password stamps nothing", async () => {
    const res = await stepUpPassword(ana.session, "not the password");
    expect(res.status).toBe(401);
    const stamps = await stampsOf(ana.session.cookie);
    expect(Date.parse(stamps.password!)).toBeLessThan(Date.now() - 5 * MINUTES);
  });

  it("the handshake belongs to its session and its purpose", async () => {
    await ready;
    const other = await login(ana.email);
    expect(other.body.passkeyRequired).toBe(true);
    const state = client.startLogin({ password: FIRST_PASSWORD });
    const started = await request<{ challengeId: string; loginResponse: string }>(
      "/api/auth/step-up/password/start",
      { cookie: ana.session.cookie, json: { startLoginRequest: state.startLoginRequest } },
    );
    const proof = client.finishLogin({
      ...state,
      password: FIRST_PASSWORD,
      loginResponse: started.body.loginResponse,
    })!;
    const body = {
      challengeId: started.body.challengeId,
      finishLoginRequest: proof.finishLoginRequest,
    };
    // Not at the login endpoint ...
    expect((await request("/api/auth/opaque/login/finish", { json: body })).status).toBe(409);
    // ... and not from another session (a second, fresh one of the same user).
    const second = await userWith(admin, "password", "bob");
    expect(
      (
        await request("/api/auth/step-up/password/finish", {
          cookie: second.session.cookie,
          json: body,
        })
      ).status,
    ).toBe(409);
  });

  it("is single use and needs a session", async () => {
    const state = client.startLogin({ password: FIRST_PASSWORD });
    expect(
      (
        await request("/api/auth/step-up/password/start", {
          json: { startLoginRequest: state.startLoginRequest },
        })
      ).status,
    ).toBe(401);
  });

  it("a passkey-only user has no password to step up with", async () => {
    const bob = await userWith(admin, "passkey", "bob");
    const res = await stepUpPassword(bob.session, FIRST_PASSWORD);
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ code: "NO_PASSWORD" });
  });

  it("is refused for impersonated sessions", async () => {
    await env.DB.prepare("UPDATE session SET impersonated_by = ? WHERE user_id = ?")
      .bind(admin.userId, ana.userId)
      .run();
    expect((await stepUpPassword(ana.session, FIRST_PASSWORD)).status).toBe(403);
  });

  it("passkey: a session stays itself; the new session the plugin makes never leaves the Worker", async () => {
    const before = await sessionCount();
    const res = await ana.passkey!.authenticate(ana.session.cookie);
    expect(res.status).toBe(200);
    expect(cookieFrom(res.headers)).not.toContain("session_token");
    expect(await sessionCount()).toBe(before);
    expect(res.body.session.id).toBeTruthy();
    expect(Date.now() - Date.parse((await stampsOf(ana.session.cookie)).passkey!)).toBeLessThan(
      MINUTES,
    );
  });
});
