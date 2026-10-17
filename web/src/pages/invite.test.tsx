import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { t } from "@/i18n";
import { mockAuth } from "@/test/auth-mock";
import { errorResponse, mockFetch, renderApp } from "@/test/helpers";

vi.mock("@/lib/auth-client", () => import("@/test/auth-mock").then((m) => m.authClientModule()));

const inFuture = () => new Date(Date.now() + 3 * 24 * 3600 * 1000).toISOString();
const info = (status: "valid" | "expired" | "used") => ({
  status,
  name: "Grace Hopper",
  email: "grace@example.com",
  expiresAt: inFuture(),
});

describe("InvitePage", () => {
  beforeEach(() => mockAuth.reset());

  it("greets the invitee and shows the account email", async () => {
    mockFetch({ "GET /api/invite/tok1": info("valid") });
    renderApp("/invite/tok1");
    expect(
      await screen.findByRole("heading", { name: t("invite.welcome", { name: "Grace Hopper" }) }),
    ).toBeInTheDocument();
    expect(screen.getByText("grace@example.com")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: t("invite.accept") })).toBeInTheDocument();
  });

  it("explains an expired invite and points to the admin", async () => {
    mockFetch({ "GET /api/invite/tok1": info("expired") });
    renderApp("/invite/tok1");
    expect(
      await screen.findByRole("heading", { name: t("invite.expiredTitle") }),
    ).toBeInTheDocument();
    expect(screen.getByText(/Ask your admin/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: t("invite.accept") })).not.toBeInTheDocument();
  });

  it("explains a used invite", async () => {
    mockFetch({ "GET /api/invite/tok1": info("used") });
    renderApp("/invite/tok1");
    expect(await screen.findByRole("heading", { name: t("invite.usedTitle") })).toBeInTheDocument();
  });

  it("treats an unknown token as not found", async () => {
    mockFetch({
      "GET /api/invite/nope": () => errorResponse(404, "not_found", "Unknown invite"),
    });
    renderApp("/invite/nope");
    expect(
      await screen.findByRole("heading", { name: t("invite.invalidTitle") }),
    ).toBeInTheDocument();
  });

  it("accepts, creates a passkey, sets a password and continues to mail", async () => {
    vi.stubGlobal("PublicKeyCredential", function PublicKeyCredential() {});
    const { calls } = mockFetch({
      "GET /api/invite/tok1": info("valid"),
      "POST /api/invite/tok1/accept": { ok: true, userId: "u9" },
      "POST /api/account/password": { ok: true },
    });
    renderApp("/invite/tok1", { config: { webmailUrl: "https://webmail.example.com" } });

    await userEvent.click(await screen.findByRole("button", { name: t("invite.accept") }));
    expect(
      await screen.findByRole("heading", { name: t("invite.secureTitle") }),
    ).toBeInTheDocument();
    expect(calls.some((c) => c.method === "POST" && c.path === "/api/invite/tok1/accept")).toBe(
      true,
    );

    const device = screen.getByLabelText(t("passkeys.nameLabel"));
    await userEvent.clear(device);
    await userEvent.type(device, "Work laptop");
    await userEvent.click(screen.getByRole("button", { name: t("passkeys.create") }));
    expect(mockAuth.client.passkey.addPasskey).toHaveBeenCalledWith({ name: "Work laptop" });
    expect(await screen.findByText(t("invite.passkeyAdded"))).toBeInTheDocument();

    await userEvent.type(screen.getByLabelText(t("password.new")), "a-long-enough-password");
    await userEvent.type(screen.getByLabelText(t("password.confirm")), "a-long-enough-password");
    await userEvent.click(screen.getByRole("button", { name: t("password.set") }));
    await waitFor(() => expect(screen.getByText(t("invite.passwordSet"))).toBeInTheDocument());
    const pw = calls.find((c) => c.path === "/api/account/password");
    expect(pw?.body).toEqual({ newPassword: "a-long-enough-password" });

    await userEvent.click(screen.getByRole("button", { name: t("invite.finish") }));
    expect(await screen.findByRole("heading", { name: t("invite.doneTitle") })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: t("invite.continueMail") })).toHaveAttribute(
      "href",
      "https://webmail.example.com",
    );
    expect(screen.getByRole("link", { name: t("invite.goAccount") })).toBeInTheDocument();
  });

  it("rejects a short or mismatched password before calling the server", async () => {
    const { calls } = mockFetch({
      "GET /api/invite/tok1": info("valid"),
      "POST /api/invite/tok1/accept": { ok: true, userId: "u9" },
    });
    renderApp("/invite/tok1");
    await userEvent.click(await screen.findByRole("button", { name: t("invite.accept") }));
    await userEvent.type(await screen.findByLabelText(t("password.new")), "short");
    await userEvent.type(screen.getByLabelText(t("password.confirm")), "different");
    await userEvent.click(screen.getByRole("button", { name: t("password.set") }));
    expect(await screen.findByText(t("password.tooShort", { min: 10 }))).toBeInTheDocument();
    expect(screen.getByText(t("password.mismatch"))).toBeInTheDocument();
    expect(calls.some((c) => c.path === "/api/account/password")).toBe(false);
  });

  it("shows the account link only when no webmail URL is configured", async () => {
    mockFetch({
      "GET /api/invite/tok1": info("valid"),
      "POST /api/invite/tok1/accept": { ok: true, userId: "u9" },
    });
    renderApp("/invite/tok1");
    await userEvent.click(await screen.findByRole("button", { name: t("invite.accept") }));
    await userEvent.click(await screen.findByRole("button", { name: t("invite.skip") }));
    expect(await screen.findByRole("link", { name: t("invite.goAccount") })).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: t("invite.continueMail") })).not.toBeInTheDocument();
  });

  it("shows a retry when the server is unreachable", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("offline")));
    renderApp("/invite/tok1");
    expect(await screen.findByText(t("error.network"))).toBeInTheDocument();
    expect(screen.getByRole("button", { name: t("common.retry") })).toBeInTheDocument();
  });
});
