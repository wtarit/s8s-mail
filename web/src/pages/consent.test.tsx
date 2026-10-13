import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { t } from "@/i18n";
import { mockAuth } from "@/test/auth-mock";
import { mockFetch, renderApp } from "@/test/helpers";

vi.mock("@/lib/auth-client", () => import("@/test/auth-mock").then((m) => m.authClientModule()));

const QUERY =
  "client_id=webmail&scope=openid+profile+email+offline_access&exp=9999999999&ba_iat=1&ba_param=client_id&ba_param=exp&ba_param=scope&sig=abc";

describe("ConsentPage", () => {
  beforeEach(() => {
    mockAuth.reset();
    mockAuth.signInAs();
    mockFetch();
  });

  it("shows the client, the signed-in user and plain-language scopes", async () => {
    renderApp(`/consent?${QUERY}`);
    expect(
      await screen.findByRole("heading", { name: t("consent.heading", { client: "Webmail" }) }),
    ).toBeInTheDocument();
    expect(mockAuth.client.oauth2.publicClient).toHaveBeenCalledWith({
      query: { client_id: "webmail" },
    });
    expect(screen.getByText("Ada Lovelace")).toBeInTheDocument();
    expect(screen.getByText("ada@example.com")).toBeInTheDocument();

    const scopes = screen.getByRole("list", { name: t("scopeList.label") });
    expect(scopes).toHaveTextContent(t("scope.openid"));
    expect(scopes).toHaveTextContent(t("scope.profile"));
    expect(scopes).toHaveTextContent(t("scope.offlineAccess"));
    // profile + email share one line; raw names stay visible underneath
    expect(scopes.querySelectorAll("li")).toHaveLength(3);
    expect(screen.getByText("profile, email")).toBeInTheDocument();
    expect(screen.getByText("offline_access")).toBeInTheDocument();
  });

  it("Allow calls consent with accept: true", async () => {
    renderApp(`/consent?${QUERY}`);
    await userEvent.click(await screen.findByRole("button", { name: t("consent.allow") }));
    expect(mockAuth.client.oauth2.consent).toHaveBeenCalledWith({ accept: true });
  });

  it("Deny calls consent with accept: false", async () => {
    renderApp(`/consent?${QUERY}`);
    await userEvent.click(await screen.findByRole("button", { name: t("consent.deny") }));
    expect(mockAuth.client.oauth2.consent).toHaveBeenCalledWith({ accept: false });
  });

  it("shows an error and re-enables the buttons when consent fails", async () => {
    mockAuth.client.oauth2.consent.mockResolvedValue({
      data: null,
      error: { message: "invalid_signature", status: 400 },
    });
    renderApp(`/consent?${QUERY}`);
    await userEvent.click(await screen.findByRole("button", { name: t("consent.allow") }));
    expect(await screen.findByText("invalid_signature")).toBeInTheDocument();
    await waitFor(() =>
      expect(screen.getByRole("button", { name: t("consent.allow") })).toBeEnabled(),
    );
  });

  it("rejects a request without a signed query", async () => {
    renderApp("/consent?client_id=webmail");
    expect(
      await screen.findByRole("heading", { name: t("consent.invalidTitle") }),
    ).toBeInTheDocument();
    expect(mockAuth.client.oauth2.publicClient).not.toHaveBeenCalled();
  });

  it("sends a signed-out user to login, returning to the consent URL", async () => {
    mockAuth.session = { data: null, isPending: false };
    renderApp(`/consent?${QUERY}`);
    await waitFor(() => expect(screen.getByTestId("location")).toHaveTextContent("/login?next="));
  });
});
