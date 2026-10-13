import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { t } from "@/i18n";
import { mockAuth } from "@/test/auth-mock";
import { ME_ADMIN, ME_USER, mockFetch, renderApp } from "@/test/helpers";

vi.mock("@/lib/auth-client", () => import("@/test/auth-mock").then((m) => m.authClientModule()));

describe("AppShell and route guards", () => {
  beforeEach(() => mockAuth.reset());

  it("redirects to /login?next=… without a session", async () => {
    mockFetch();
    renderApp("/account/passkeys");
    await waitFor(() =>
      expect(screen.getByTestId("location")).toHaveTextContent(
        `/login?next=${encodeURIComponent("/account/passkeys")}`,
      ),
    );
  });

  it("redirects to /login when /api/me answers 401", async () => {
    mockAuth.signInAs();
    mockFetch({
      "GET /api/me": () =>
        Response.json({ error: { code: "unauthorized", message: "No" } }, { status: 401 }),
    });
    renderApp("/account/profile");
    await waitFor(() => expect(screen.getByTestId("location")).toHaveTextContent("/login"));
  });

  it("shows account and admin navigation to an admin", async () => {
    mockAuth.signInAs();
    mockFetch();
    renderApp("/account/passkeys");
    expect(await screen.findByRole("heading", { name: t("passkeys.title") })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: t("nav.appPasswords") })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: t("nav.users") })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: t("nav.clients") })).toBeInTheDocument();
  });

  it("hides the Admin nav from a non-admin and bounces /admin/* to the profile", async () => {
    mockAuth.signInAs();
    mockFetch({ "GET /api/me": ME_USER });
    renderApp("/admin/users");
    expect(await screen.findByRole("heading", { name: t("profile.title") })).toBeInTheDocument();
    expect(screen.getByTestId("location")).toHaveTextContent("/account/profile");
    expect(screen.queryByRole("link", { name: t("nav.users") })).not.toBeInTheDocument();
    expect(screen.queryByText(t("nav.admin"))).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: t("nav.sessions") })).toBeInTheDocument();
  });

  it("user menu shows name and email and signs out", async () => {
    mockAuth.signInAs();
    mockFetch({ "GET /api/me": ME_ADMIN });
    mockAuth.client.signOut.mockImplementation(async () => {
      mockAuth.session = { data: null, isPending: false };
      return { data: { success: true }, error: null };
    });
    renderApp("/account/profile");
    await userEvent.click(await screen.findByRole("button", { name: t("userMenu.label") }));
    expect(await screen.findByText(ME_ADMIN.user.email, { selector: "span" })).toBeInTheDocument();
    await userEvent.click(screen.getByRole("menuitem", { name: t("userMenu.signOut") }));
    await waitFor(() => expect(mockAuth.client.signOut).toHaveBeenCalled());
    await waitFor(() => expect(screen.getByTestId("location")).toHaveTextContent("/login"));
  });
});
