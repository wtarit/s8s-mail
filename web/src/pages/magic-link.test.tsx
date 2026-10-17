import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { t } from "@/i18n";
import { mockAuth } from "@/test/auth-mock";
import { mockFetch, renderApp } from "@/test/helpers";

vi.mock("@/lib/auth-client", () => import("@/test/auth-mock").then((m) => m.authClientModule()));

describe("magic link pages", () => {
  beforeEach(() => {
    mockAuth.reset();
    mockFetch();
  });

  it("sent page says the link goes to the recovery address, with expiry and resend", async () => {
    renderApp("/magic-link/sent", {
      state: { email: "ada@example.com", next: "/account/profile" },
    });
    expect(screen.getByRole("heading", { name: t("magicLinkSent.title") })).toBeInTheDocument();
    expect(screen.getByText(t("magicLinkSent.notMailbox"))).toBeInTheDocument();
    expect(screen.getByText(t("magicLinkSent.expiry", { minutes: 15 }))).toBeInTheDocument();
    // resend is on cooldown first
    expect(screen.getByRole("button", { name: /Send again in/ })).toBeDisabled();
  });

  it("sent page without state offers only the way back", () => {
    renderApp("/magic-link/sent");
    expect(screen.queryByRole("button", { name: /Send/ })).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: t("magicLinkSent.back") })).toBeInTheDocument();
  });

  it("verify page explains an expired link", () => {
    renderApp("/magic-link/verify?error=EXPIRED_TOKEN");
    expect(
      screen.getByRole("heading", { name: t("magicLinkVerify.expiredTitle") }),
    ).toBeInTheDocument();
    expect(screen.getByRole("link", { name: t("magicLinkVerify.backToLogin") })).toHaveAttribute(
      "href",
      "/login",
    );
  });

  it("verify page explains a used link", () => {
    renderApp("/magic-link/verify?error=ATTEMPTS_EXCEEDED");
    expect(
      screen.getByRole("heading", { name: t("magicLinkVerify.usedTitle") }),
    ).toBeInTheDocument();
  });

  it("verify page shows a generic failure for unknown error codes", () => {
    renderApp("/magic-link/verify?error=SOMETHING_ELSE");
    expect(
      screen.getByRole("heading", { name: t("magicLinkVerify.failedTitle") }),
    ).toBeInTheDocument();
  });

  it("verify page continues to ?next once the session exists", async () => {
    mockAuth.signInAs();
    renderApp("/magic-link/verify?next=/account/passkeys");
    await waitFor(() =>
      expect(screen.getByTestId("location")).toHaveTextContent("/account/passkeys"),
    );
  });

  it("verify page redeems a raw token through the client", async () => {
    renderApp("/magic-link/verify?token=abc");
    await waitFor(() =>
      expect(mockAuth.client.magicLink.verify).toHaveBeenCalledWith({ query: { token: "abc" } }),
    );
    expect(screen.getByRole("heading", { name: t("magicLinkVerify.title") })).toBeInTheDocument();
  });

  it("verify page without session, token or error goes back to login", async () => {
    renderApp("/magic-link/verify");
    await waitFor(() => expect(screen.getByTestId("location")).toHaveTextContent("/login"));
  });

  it("resend calls the client again once the cooldown has passed", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      renderApp("/magic-link/sent", { state: { email: "ada@example.com" } });
      vi.setSystemTime(Date.now() + 31_000);
      const button = await screen.findByRole(
        "button",
        { name: t("magicLinkSent.resend") },
        { timeout: 3000 },
      );
      await userEvent.click(button);
      expect(mockAuth.client.signIn.magicLink).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });
});
