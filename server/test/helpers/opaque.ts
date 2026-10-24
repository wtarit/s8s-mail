import { client, ready } from "../../src/auth/.generated/opaque-worker.mjs";
import { cookieFrom, request, type Json, type Session } from "./index";

export const FIRST_PASSWORD = "first opaque password 123";
export const NEXT_PASSWORD = "second opaque password 456";

/** Real Serenity client operations, using its default memory-constrained Argon2id. */
export async function beginLogin(email: string, password = FIRST_PASSWORD) {
  await ready;
  const state = client.startLogin({ password });
  const started = await request<{ challengeId: string; loginResponse: string }>(
    "/api/auth/opaque/login/start",
    { json: { email, startLoginRequest: state.startLoginRequest } },
  );
  if (started.status !== 200) throw new Error(`login start: ${JSON.stringify(started)}`);
  const finished = client.finishLogin({
    ...state,
    password,
    loginResponse: started.body.loginResponse,
  });
  return {
    started,
    accepted: !!finished,
    body: {
      challengeId: started.body.challengeId,
      // Deliberately invalid proof allows tests to exercise server rejection too.
      finishLoginRequest: finished?.finishLoginRequest ?? state.startLoginRequest,
    },
  };
}

export async function login(email = "ana@example.com", password = FIRST_PASSWORD) {
  const pending = await beginLogin(email, password);
  const response = await request<Json>("/api/auth/opaque/login/finish", {
    json: pending.body,
  });
  return {
    ...response,
    cookie: cookieFrom(response.headers),
    accepted: pending.accepted,
    proof: pending.body,
  };
}

export async function beginPassword(
  session: Session,
  password = FIRST_PASSWORD,
  currentPassword?: string,
) {
  await ready;
  const registration = client.startRegistration({ password });
  const current = currentPassword ? client.startLogin({ password: currentPassword }) : undefined;
  const started = await request<{
    challengeId: string;
    registrationResponse: string;
    loginResponse?: string;
  }>("/api/auth/opaque/password/start", {
    cookie: session.cookie,
    json: {
      registrationRequest: registration.registrationRequest,
      ...(current ? { startLoginRequest: current.startLoginRequest } : {}),
    },
  });
  if (started.status !== 200) throw new Error(`password start: ${JSON.stringify(started)}`);
  const { registrationRecord } = client.finishRegistration({
    ...registration,
    password,
    registrationResponse: started.body.registrationResponse,
  });
  const proof =
    current && currentPassword && started.body.loginResponse
      ? client.finishLogin({
          ...current,
          password: currentPassword,
          loginResponse: started.body.loginResponse,
        })
      : undefined;
  return {
    started,
    currentAccepted: !!proof,
    body: {
      challengeId: started.body.challengeId,
      registrationRecord,
      ...(proof ? { finishLoginRequest: proof.finishLoginRequest } : {}),
    },
  };
}

export async function setPassword(
  session: Session,
  password = FIRST_PASSWORD,
  currentPassword?: string,
) {
  const pending = await beginPassword(session, password, currentPassword);
  const response = await request("/api/auth/opaque/password/finish", {
    cookie: session.cookie,
    json: pending.body,
  });
  if (response.status !== 200) throw new Error(`password finish: ${JSON.stringify(response)}`);
  return response;
}

export async function sessionId(session: Session) {
  const response = await request<{ session: { id: string } }>("/api/auth/get-session", {
    cookie: session.cookie,
  });
  if (response.status !== 200 || !response.body?.session) throw new Error("Missing test session");
  return response.body.session.id;
}

/** Password step-up for an existing session (an OPAQUE login bound to that session). */
export async function stepUpPassword(session: Session, password = FIRST_PASSWORD) {
  await ready;
  const state = client.startLogin({ password });
  const started = await request<{ challengeId: string; loginResponse: string }>(
    "/api/auth/step-up/password/start",
    { cookie: session.cookie, json: { startLoginRequest: state.startLoginRequest } },
  );
  if (started.status !== 200) return started;
  const finished = client.finishLogin({
    ...state,
    password,
    loginResponse: started.body.loginResponse,
  });
  return request("/api/auth/step-up/password/finish", {
    cookie: session.cookie,
    json: {
      challengeId: started.body.challengeId,
      finishLoginRequest: finished?.finishLoginRequest ?? state.startLoginRequest,
    },
  });
}
