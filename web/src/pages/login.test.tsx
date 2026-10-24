import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { t } from "@/i18n";
import { mockAuth } from "@/test/auth-mock";
import { mockFetch, renderApp } from "@/test/helpers";

vi.mock("@/lib/auth-client", () => import("@/test/auth-mock").then((m) => m.authClientModule()));

const SIGNED_QUERY =
  "client_id=webmail&redirect_uri=https%3A%2F%2Fwebmail.example.com%2Fcb&response_type=code&scope=openid+profile&state=xyz&prompt=login&exp=9999999999&ba_iat=1&ba_param=client_id&ba_param=exp&ba_param=prompt&ba_param=redirect_uri&ba_param=response_type&ba_param=scope&ba_param=state&sig=abc";

describe("LoginPage", () => {
  beforeEach(() => {
    mockAuth.reset();
    mockFetch();
  });

  it("offers passkey, password and magic-link sign-in", () => {
    renderApp("/login");
    expect(screen.getByRole("heading", { name: t("login.title") })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: t("login.passkey") })).toBeInTheDocument();
    expect(screen.getByLabelText(t("login.passwordLabel"))).toBeInTheDocument();
    expect(screen.getByRole("button", { name: t("login.submit") })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: t("login.magicLink") })).toBeInTheDocument();
    expect(screen.getByLabelText(t("login.emailLabel"))).toHaveAttribute(
      "autocomplete",
      "username webauthn",
    );
    // the recovery-address promise is stated on the page
    expect(screen.getByText(t("login.magicLinkHint"))).toBeInTheDocument();
  });

  it("signs in with email and password, then follows ?next", async () => {
    renderApp("/login?next=/account/sessions");
    await userEvent.type(screen.getByLabelText(t("login.emailLabel")), "ada@example.com");
    await userEvent.type(screen.getByLabelText(t("login.passwordLabel")), "correct horse");
    await userEvent.click(screen.getByRole("button", { name: t("login.submit") }));
    expect(mockAuth.client.signIn.opaque).toHaveBeenCalledWith({
      email: "ada@example.com",
      password: "correct horse",
    });
    await waitFor(() =>
      expect(screen.getByTestId("location")).toHaveTextContent("/account/sessions"),
    );
  });

  it("ignores an off-site ?next", async () => {
    renderApp("/login?next=//evil.example.net");
    await userEvent.type(screen.getByLabelText(t("login.emailLabel")), "ada@example.com");
    await userEvent.type(screen.getByLabelText(t("login.passwordLabel")), "pw");
    await userEvent.click(screen.getByRole("button", { name: t("login.submit") }));
    await waitFor(() =>
      expect(screen.getByTestId("location")).toHaveTextContent("/account/profile"),
    );
  });

  it("shows an inline error for wrong credentials and stays on the page", async () => {
    mockAuth.client.signIn.opaque.mockResolvedValue({
      data: null,
      error: {
        code: "INVALID_EMAIL_OR_PASSWORD",
        status: 401,
        message: "Invalid email or password",
      },
    });
    renderApp("/login");
    await userEvent.type(screen.getByLabelText(t("login.emailLabel")), "ada@example.com");
    await userEvent.type(screen.getByLabelText(t("login.passwordLabel")), "nope");
    await userEvent.click(screen.getByRole("button", { name: t("login.submit") }));
    expect(await screen.findByText(t("login.invalidCredentials"))).toBeInTheDocument();
    expect(screen.getByTestId("location")).toHaveTextContent("/login");
  });

  it("validates the email before calling the client", async () => {
    renderApp("/login");
    await userEvent.click(screen.getByRole("button", { name: t("login.submit") }));
    expect(await screen.findByText(t("login.emailRequired"))).toBeInTheDocument();
    expect(screen.getByText(t("login.passwordRequired"))).toBeInTheDocument();
    expect(mockAuth.client.signIn.opaque).not.toHaveBeenCalled();
  });

  it("signs in with a passkey", async () => {
    renderApp("/login");
    await userEvent.click(screen.getByRole("button", { name: t("login.passkey") }));
    expect(mockAuth.client.signIn.passkey).toHaveBeenCalledWith();
    await waitFor(() =>
      expect(screen.getByTestId("location")).toHaveTextContent("/account/profile"),
    );
  });

  it("starts passkey autofill when the browser supports conditional UI", async () => {
    vi.stubGlobal(
      "PublicKeyCredential",
      Object.assign(function PublicKeyCredential() {}, {
        isConditionalMediationAvailable: () => Promise.resolve(true),
      }),
    );
    mockAuth.client.signIn.passkey.mockReturnValue(new Promise(() => {}));
    renderApp("/login");
    await waitFor(() =>
      expect(mockAuth.client.signIn.passkey).toHaveBeenCalledWith({ autoFill: true }),
    );
  });

  it("emails a magic link and moves to the sent page", async () => {
    renderApp("/login?next=/account/passkeys");
    await userEvent.type(screen.getByLabelText(t("login.emailLabel")), "ada@example.com");
    await userEvent.click(screen.getByRole("button", { name: t("login.magicLink") }));
    expect(mockAuth.client.signIn.magicLink).toHaveBeenCalledTimes(1);
    const arg = mockAuth.client.signIn.magicLink.mock.calls[0]?.[0] as {
      email: string;
      callbackURL: string;
      errorCallbackURL: string;
    };
    expect(arg.email).toBe("ada@example.com");
    expect(arg.callbackURL).toBe(
      `${window.location.origin}/magic-link/verify?next=${encodeURIComponent("/account/passkeys")}`,
    );
    expect(arg.errorCallbackURL).toBe(`${window.location.origin}/magic-link/verify`);
    await waitFor(() =>
      expect(screen.getByTestId("location")).toHaveTextContent("/magic-link/sent"),
    );
    expect(
      await screen.findByRole("heading", { name: t("magicLinkSent.title") }),
    ).toBeInTheDocument();
  });

  it("requires an email for the magic link", async () => {
    renderApp("/login");
    await userEvent.click(screen.getByRole("button", { name: t("login.magicLink") }));
    expect(await screen.findByText(t("login.emailRequired"))).toBeInTheDocument();
    expect(mockAuth.client.signIn.magicLink).not.toHaveBeenCalled();
  });

  it("resumes an OAuth authorization through the magic link callback", async () => {
    renderApp(`/login?${SIGNED_QUERY}`);
    await userEvent.type(screen.getByLabelText(t("login.emailLabel")), "ada@example.com");
    await userEvent.click(screen.getByRole("button", { name: t("login.magicLink") }));
    const arg = mockAuth.client.signIn.magicLink.mock.calls[0]?.[0] as { callbackURL: string };
    const next = new URL(arg.callbackURL).searchParams.get("next") ?? "";
    const resume = new URL(next);
    expect(resume.pathname).toBe("/api/auth/oauth2/authorize");
    expect(resume.searchParams.get("client_id")).toBe("webmail");
    expect(resume.searchParams.get("state")).toBe("xyz");
    expect(resume.searchParams.has("sig")).toBe(false);
    expect(resume.searchParams.has("prompt")).toBe(false);
  });

  it("does not navigate itself when Better Auth continues an OAuth request", async () => {
    mockAuth.client.signIn.opaque.mockResolvedValue({
      data: { redirect: true, url: "https://webmail.example.com/cb?code=1" },
      error: null,
    });
    renderApp(`/login?${SIGNED_QUERY}`);
    expect(screen.getByText(t("login.subtitleContinue"))).toBeInTheDocument();
    await userEvent.type(screen.getByLabelText(t("login.emailLabel")), "ada@example.com");
    await userEvent.type(screen.getByLabelText(t("login.passwordLabel")), "pw");
    await userEvent.click(screen.getByRole("button", { name: t("login.submit") }));
    await waitFor(() => expect(mockAuth.client.signIn.opaque).toHaveBeenCalled());
    expect(screen.getByTestId("location")).toHaveTextContent("/login?client_id=webmail");
  });

  it("asks a 2FA user for the passkey after the password and follows ?next", async () => {
    mockAuth.client.signIn.opaque.mockResolvedValue({
      data: { passkeyRequired: true, redirect: false },
      error: null,
    });
    mockAuth.client.signIn.passkey.mockImplementation(async () => {
      mockAuth.signInAs();
      return { data: { user: { id: "u1" } }, error: null };
    });
    renderApp("/login?next=/account/sessions");
    await userEvent.type(screen.getByLabelText(t("login.emailLabel")), "ada@example.com");
    await userEvent.type(screen.getByLabelText(t("login.passwordLabel")), "correct horse");
    await userEvent.click(screen.getByRole("button", { name: t("login.submit") }));

    expect(
      await screen.findByRole("heading", { name: t("secondFactor.title") }),
    ).toBeInTheDocument();
    expect(screen.getByText("ada@example.com")).toBeInTheDocument();
    // only the passkey can finish a password-first sign-in
    expect(screen.queryByLabelText(t("login.passwordLabel"))).not.toBeInTheDocument();
    expect(screen.getByTestId("location")).toHaveTextContent("/login");

    await userEvent.click(screen.getByRole("button", { name: t("secondFactor.passkey") }));
    expect(mockAuth.client.signIn.passkey).toHaveBeenCalledWith();
    await waitFor(() =>
      expect(screen.getByTestId("location")).toHaveTextContent("/account/sessions"),
    );
  });

  it("keeps the OAuth continuation in the passkey second step", async () => {
    mockAuth.client.signIn.opaque.mockResolvedValue({
      data: { passkeyRequired: true, redirect: false },
      error: null,
    });
    mockAuth.client.signIn.passkey.mockResolvedValue({
      data: { redirect: true, url: "https://webmail.example.com/cb?code=1" },
      error: null,
    });
    renderApp(`/login?${SIGNED_QUERY}`);
    await userEvent.type(screen.getByLabelText(t("login.emailLabel")), "ada@example.com");
    await userEvent.type(screen.getByLabelText(t("login.passwordLabel")), "pw");
    await userEvent.click(screen.getByRole("button", { name: t("login.submit") }));
    await userEvent.click(await screen.findByRole("button", { name: t("secondFactor.passkey") }));
    await waitFor(() => expect(mockAuth.client.signIn.passkey).toHaveBeenCalled());
    // the client's OAuth plugin follows the redirect; the page does not navigate itself
    expect(screen.getByTestId("location")).toHaveTextContent("/login?client_id=webmail");
  });

  it("shows an error and stays on the second step when the passkey fails", async () => {
    mockAuth.client.signIn.opaque.mockResolvedValue({
      data: { passkeyRequired: true, redirect: false },
      error: null,
    });
    mockAuth.client.signIn.passkey.mockResolvedValue({
      data: null,
      error: { code: "AUTH_CANCELLED", message: "Cancelled", status: 400 },
    });
    renderApp("/login");
    await userEvent.type(screen.getByLabelText(t("login.emailLabel")), "ada@example.com");
    await userEvent.type(screen.getByLabelText(t("login.passwordLabel")), "pw");
    await userEvent.click(screen.getByRole("button", { name: t("login.submit") }));
    await userEvent.click(await screen.findByRole("button", { name: t("secondFactor.passkey") }));
    expect(await screen.findByText("Cancelled")).toBeInTheDocument();
    expect(screen.getByTestId("location")).toHaveTextContent("/login");
  });

  it("goes back to the sign-in form from the second step", async () => {
    mockAuth.client.signIn.opaque.mockResolvedValue({
      data: { passkeyRequired: true, redirect: false },
      error: null,
    });
    renderApp("/login");
    await userEvent.type(screen.getByLabelText(t("login.emailLabel")), "ada@example.com");
    await userEvent.type(screen.getByLabelText(t("login.passwordLabel")), "pw");
    await userEvent.click(screen.getByRole("button", { name: t("login.submit") }));
    await userEvent.click(await screen.findByRole("button", { name: t("secondFactor.back") }));
    expect(screen.getByRole("heading", { name: t("login.title") })).toBeInTheDocument();
  });

  it("resumes a pending sign-in with the factors the server still accepts", async () => {
    mockFetch({
      "GET /api/auth/pending-sign-in": {
        pending: { via: "recovery", email: "ada@example.com", factors: ["passkey", "password"] },
      },
    });
    renderApp("/login");
    expect(await screen.findByText(t("secondFactor.bodyRecovery"))).toBeInTheDocument();
    expect(screen.getByRole("button", { name: t("secondFactor.passkey") })).toBeInTheDocument();
    await userEvent.type(screen.getByLabelText(t("login.passwordLabel")), "my-password");
    await userEvent.click(screen.getByRole("button", { name: t("login.submit") }));
    // a normal OPAQUE login with the email from the pending response
    expect(mockAuth.client.signIn.opaque).toHaveBeenCalledWith({
      email: "ada@example.com",
      password: "my-password",
    });
  });

  it("redirects away when already signed in", async () => {
    mockAuth.signInAs();
    renderApp("/login?next=/account/sessions");
    await waitFor(() =>
      expect(screen.getByTestId("location")).toHaveTextContent("/account/sessions"),
    );
  });
});
