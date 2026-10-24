import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { t } from "@/i18n";
import { mockAuth } from "@/test/auth-mock";
import { ME_USER, meWithAccountChange, mockFetch, renderApp } from "@/test/helpers";

vi.mock("@/lib/auth-client", () => import("@/test/auth-mock").then((m) => m.authClientModule()));

const ok = (data: unknown) => ({ data, error: null });

describe("Account / App passwords", () => {
  beforeEach(() => {
    mockAuth.reset();
    mockAuth.signInAs();
    mockFetch({ "GET /api/me": ME_USER });
  });

  it("shows the key once, then hides it after closing", async () => {
    const created = {
      id: "k1",
      name: "Thunderbird",
      key: "s8s_AbCdEf0123456789",
      createdAt: "2026-10-12T10:00:00.000Z",
      lastRequest: null,
    };
    mockAuth.client.apiKey.create.mockResolvedValue(ok(created));
    const user = userEvent.setup();
    renderApp("/account/app-passwords");

    // explains how to use it, with the email as the username
    expect(
      await screen.findByText(t("appPasswords.description", { email: "ada@example.com" })),
    ).toBeInTheDocument();
    expect(await screen.findByText(t("appPasswords.empty"))).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: t("appPasswords.create") }));
    const dialog = await screen.findByRole("dialog");
    await user.type(within(dialog).getByLabelText(t("appPasswords.nameLabel")), "Thunderbird");
    // after creating, the list reload returns the key without its secret
    mockAuth.client.apiKey.list.mockResolvedValue(
      ok({ apiKeys: [{ ...created, key: undefined }], total: 1 }),
    );
    await user.click(within(dialog).getByRole("button", { name: t("appPasswords.createSubmit") }));
    expect(mockAuth.client.apiKey.create).toHaveBeenCalledWith({ name: "Thunderbird" });

    expect(await within(dialog).findByLabelText(t("appPasswords.keyLabel"))).toHaveValue(
      created.key,
    );
    expect(within(dialog).getByText(t("appPasswords.shownOnce"))).toBeInTheDocument();

    await user.click(within(dialog).getByRole("button", { name: t("common.done") }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());

    // gone from the page, and a fresh dialog starts blank
    expect(screen.queryByDisplayValue(created.key)).not.toBeInTheDocument();
    expect(document.body).not.toHaveTextContent(created.key);
    expect(await screen.findByText("Thunderbird")).toBeInTheDocument();
    expect(screen.getByText(t("appPasswords.neverUsed"), { exact: false })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: t("appPasswords.create") }));
    const again = await screen.findByRole("dialog");
    expect(within(again).getByLabelText(t("appPasswords.nameLabel"))).toHaveValue("");
    expect(within(again).queryByLabelText(t("appPasswords.keyLabel"))).not.toBeInTheDocument();
  });

  it("revokes only after a confirmation that names the app", async () => {
    mockAuth.client.apiKey.list.mockResolvedValue(
      ok({
        apiKeys: [
          {
            id: "k1",
            name: "Thunderbird",
            createdAt: "2026-10-01T10:00:00.000Z",
            lastRequest: "2026-10-10T10:00:00.000Z",
          },
        ],
      }),
    );
    const user = userEvent.setup();
    renderApp("/account/app-passwords");
    await user.click(
      await screen.findByRole("button", {
        name: t("appPasswords.revokeAria", { name: "Thunderbird" }),
      }),
    );
    const dialog = await screen.findByRole("alertdialog");
    expect(
      within(dialog).getByText(t("appPasswords.revokeTitle", { name: "Thunderbird" })),
    ).toBeInTheDocument();
    expect(mockAuth.client.apiKey.delete).not.toHaveBeenCalled();
    await user.click(within(dialog).getByRole("button", { name: t("appPasswords.revoke") }));
    await waitFor(() =>
      expect(mockAuth.client.apiKey.delete).toHaveBeenCalledWith({ keyId: "k1" }),
    );
    expect(await screen.findByText(t("appPasswords.revoked"))).toBeInTheDocument();
  });
});

describe("Account / Passkeys", () => {
  beforeEach(() => {
    mockAuth.reset();
    mockAuth.signInAs();
    mockFetch({ "GET /api/me": ME_USER });
  });

  it("lists, renames and removes passkeys", async () => {
    mockAuth.client.passkey.listUserPasskeys.mockResolvedValue(
      ok([
        {
          id: "p1",
          name: "Work laptop",
          createdAt: "2026-09-01T10:00:00.000Z",
          deviceType: "singleDevice",
        },
      ]),
    );
    const user = userEvent.setup();
    renderApp("/account/passkeys");
    expect(await screen.findByText("Work laptop")).toBeInTheDocument();

    await user.click(
      screen.getByRole("button", { name: t("passkeys.renameAria", { name: "Work laptop" }) }),
    );
    const rename = await screen.findByRole("dialog");
    const input = within(rename).getByLabelText(t("passkeys.nameLabel"));
    await user.clear(input);
    await user.type(input, "Desk");
    await user.click(within(rename).getByRole("button", { name: t("common.save") }));
    await waitFor(() =>
      expect(mockAuth.client.passkey.updatePasskey).toHaveBeenCalledWith({
        id: "p1",
        name: "Desk",
      }),
    );

    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    await user.click(
      screen.getByRole("button", { name: t("passkeys.removeAria", { name: "Work laptop" }) }),
    );
    const confirm = await screen.findByRole("alertdialog");
    await user.click(within(confirm).getByRole("button", { name: t("passkeys.remove") }));
    await waitFor(() =>
      expect(mockAuth.client.passkey.deletePasskey).toHaveBeenCalledWith({ id: "p1" }),
    );
  });

  it("adds a passkey with a device name", async () => {
    vi.stubGlobal("PublicKeyCredential", function PublicKeyCredential() {});
    const user = userEvent.setup();
    renderApp("/account/passkeys");
    await user.click(await screen.findByRole("button", { name: t("passkeys.add") }));
    const dialog = await screen.findByRole("dialog");
    const input = within(dialog).getByLabelText(t("passkeys.nameLabel"));
    await user.clear(input);
    await user.type(input, "Phone");
    await user.click(within(dialog).getByRole("button", { name: t("passkeys.create") }));
    await waitFor(() =>
      expect(mockAuth.client.passkey.addPasskey).toHaveBeenCalledWith({ name: "Phone" }),
    );
  });
});

describe("Account / Sessions", () => {
  beforeEach(() => {
    mockAuth.reset();
    mockAuth.signInAs({}, "tok-current");
    mockFetch({ "GET /api/me": ME_USER });
  });

  it("marks the current session and revokes another one", async () => {
    mockAuth.client.listSessions.mockResolvedValue(
      ok([
        {
          id: "s1",
          token: "tok-current",
          userAgent: "Mozilla/5.0 (X11; Linux x86_64; rv:130.0) Gecko/20100101 Firefox/130.0",
          ipAddress: "203.0.113.5",
          createdAt: "2026-10-12T08:00:00.000Z",
          updatedAt: "2026-10-12T09:00:00.000Z",
        },
        {
          id: "s2",
          token: "tok-other",
          userAgent:
            "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148 Safari/604.1",
          ipAddress: null,
          createdAt: "2026-10-11T08:00:00.000Z",
          updatedAt: "2026-10-11T09:00:00.000Z",
        },
      ]),
    );
    const user = userEvent.setup();
    renderApp("/account/sessions");
    expect(await screen.findByText("Firefox on Linux")).toBeInTheDocument();
    expect(screen.getByText(t("sessions.current"))).toBeInTheDocument();
    expect(screen.getByText("Safari on iOS")).toBeInTheDocument();

    await user.click(
      screen.getByRole("button", { name: t("sessions.revokeAria", { device: "Safari on iOS" }) }),
    );
    const dialog = await screen.findByRole("alertdialog");
    await user.click(within(dialog).getByRole("button", { name: t("sessions.revoke") }));
    await waitFor(() =>
      expect(mockAuth.client.revokeSession).toHaveBeenCalledWith({ token: "tok-other" }),
    );
  });
});

describe("Account / Password", () => {
  beforeEach(() => {
    mockAuth.reset();
    mockAuth.signInAs();
  });

  it("asks for the current password when one is set", async () => {
    mockFetch({ "GET /api/me": ME_USER });
    const user = userEvent.setup();
    renderApp("/account/password");
    await user.type(await screen.findByLabelText(t("password.current")), "old-password");
    await user.type(screen.getByLabelText(t("password.new")), "brand-new-password");
    await user.type(screen.getByLabelText(t("password.confirm")), "brand-new-password");
    await user.click(screen.getByRole("button", { name: t("password.change") }));
    await waitFor(() =>
      expect(mockAuth.client.opaque.setPassword).toHaveBeenCalledWith({
        currentPassword: "old-password",
        newPassword: "brand-new-password",
      }),
    );
  });

  it("allows password recovery without the current password", async () => {
    mockFetch({ "GET /api/me": meWithAccountChange({ currentPasswordRequired: false }) });
    renderApp("/account/password");
    expect(await screen.findByText(t("password.descriptionRecovery"))).toBeInTheDocument();
    expect(screen.queryByLabelText(t("password.current"))).not.toBeInTheDocument();
    await userEvent.type(screen.getByLabelText(t("password.new")), "recovered-password");
    await userEvent.type(screen.getByLabelText(t("password.confirm")), "recovered-password");
    await userEvent.click(screen.getByRole("button", { name: t("password.change") }));
    await waitFor(() =>
      expect(mockAuth.client.opaque.setPassword).toHaveBeenCalledWith({
        newPassword: "recovered-password",
      }),
    );
  });

  it("does not ask for a current password for a first password", async () => {
    mockFetch({
      "GET /api/me": {
        ...meWithAccountChange({ currentPasswordRequired: false }),
        user: {
          ...meWithAccountChange({ currentPasswordRequired: false }).user,
          hasPassword: false,
        },
      },
    });
    renderApp("/account/password");
    expect(await screen.findByLabelText(t("password.new"))).toBeInTheDocument();
    expect(screen.getByText(t("password.descriptionSet"))).toBeInTheDocument();
    expect(screen.queryByLabelText(t("password.current"))).not.toBeInTheDocument();
  });

  it("requires the current password before changing an existing one", async () => {
    mockFetch({ "GET /api/me": ME_USER });
    renderApp("/account/password");
    await userEvent.type(await screen.findByLabelText(t("password.new")), "brand-new-password");
    await userEvent.type(screen.getByLabelText(t("password.confirm")), "brand-new-password");
    await userEvent.click(screen.getByRole("button", { name: t("password.change") }));
    expect(await screen.findByText(t("password.currentRequired"))).toBeInTheDocument();
    expect(mockAuth.client.opaque.setPassword).not.toHaveBeenCalled();
  });

  it("flags a wrong current password on its field", async () => {
    mockFetch({ "GET /api/me": ME_USER });
    mockAuth.client.opaque.setPassword.mockResolvedValue({
      data: null,
      error: { code: "INVALID_EMAIL_OR_PASSWORD", message: "Incorrect", status: 401 },
    });
    renderApp("/account/password");
    await userEvent.type(await screen.findByLabelText(t("password.current")), "wrong");
    await userEvent.type(screen.getByLabelText(t("password.new")), "brand-new-password");
    await userEvent.type(screen.getByLabelText(t("password.confirm")), "brand-new-password");
    await userEvent.click(screen.getByRole("button", { name: t("password.change") }));
    expect(await screen.findByText(t("password.currentWrong"))).toBeInTheDocument();
  });
});

describe("Account / Profile", () => {
  it("shows the masked recovery address and that the admin can change it", async () => {
    mockAuth.reset();
    mockAuth.signInAs();
    mockFetch({ "GET /api/me": ME_USER });
    renderApp("/account/profile");
    expect(await screen.findByText("a•••@example.org")).toBeInTheDocument();
    expect(screen.getByText(t("profile.recoveryHelp"))).toBeInTheDocument();
    expect(screen.getByText(t("role.user"))).toBeInTheDocument();
  });
});
