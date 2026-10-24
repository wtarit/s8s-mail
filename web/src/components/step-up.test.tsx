import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { t } from "@/i18n";
import { mockAuth } from "@/test/auth-mock";
import { meWithAccountChange, mockFetch, renderApp } from "@/test/helpers";

vi.mock("@/lib/auth-client", () => import("@/test/auth-mock").then((m) => m.authClientModule()));

const ok = (data: unknown = {}) => ({ data, error: null });
type AccountChange = Parameters<typeof meWithAccountChange>[0];

/** `/api/me` whose account-change state the test can move on (as the server would after step-up). */
function serveMe(initial: AccountChange) {
  let state = initial;
  mockFetch({ "GET /api/me": () => meWithAccountChange(state) });
  return (next: AccountChange) => {
    state = next;
  };
}
const FRESH: AccountChange = { allowed: true, stale: [], oneOf: false };

beforeEach(() => {
  mockAuth.reset();
  mockAuth.signInAs();
  vi.stubGlobal("PublicKeyCredential", function PublicKeyCredential() {});
});

async function fillNewPassword(value = "brand-new-password") {
  await userEvent.type(await screen.findByLabelText(t("password.new")), value);
  await userEvent.type(screen.getByLabelText(t("password.confirm")), value);
}

describe("step-up prompt", () => {
  it("asks only for the stale passkey on the password page: the current password covers the rest", async () => {
    const setMe = serveMe({ allowed: false, stale: ["password", "passkey"], oneOf: false });
    mockAuth.client.signIn.passkey.mockImplementation(async () => {
      setMe(FRESH);
      return ok({ session: {} });
    });
    renderApp("/account/password");
    await userEvent.type(await screen.findByLabelText(t("password.current")), "old-password");
    await fillNewPassword();
    await userEvent.click(screen.getByRole("button", { name: t("password.change") }));

    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByRole("button", { name: t("stepUp.verifyPasskey") })).toBeVisible();
    expect(within(dialog).queryByLabelText(t("stepUp.password"))).not.toBeInTheDocument();
    expect(mockAuth.client.opaque.setPassword).not.toHaveBeenCalled();

    await userEvent.click(within(dialog).getByRole("button", { name: t("stepUp.verifyPasskey") }));
    await waitFor(() =>
      expect(mockAuth.client.opaque.setPassword).toHaveBeenCalledWith({
        currentPassword: "old-password",
        newPassword: "brand-new-password",
      }),
    );
    expect(mockAuth.client.opaque.stepUp).not.toHaveBeenCalled();
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(await screen.findByText(t("password.saved"))).toBeInTheDocument();
  });

  it("does not prompt at all when only the password is stale and the form proves it", async () => {
    serveMe({ allowed: false, stale: ["password"], oneOf: false });
    renderApp("/account/password");
    await userEvent.type(await screen.findByLabelText(t("password.current")), "old-password");
    await fillNewPassword();
    await userEvent.click(screen.getByRole("button", { name: t("password.change") }));
    await waitFor(() => expect(mockAuth.client.opaque.setPassword).toHaveBeenCalled());
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("asks for each stale factor in turn before adding a passkey", async () => {
    const setMe = serveMe({ allowed: false, stale: ["password", "passkey"], oneOf: false });
    mockAuth.client.opaque.stepUp.mockImplementation(async () => {
      setMe({ allowed: false, stale: ["passkey"], oneOf: false });
      return ok({ ok: true });
    });
    mockAuth.client.signIn.passkey.mockImplementation(async () => {
      setMe(FRESH);
      return ok({ session: {} });
    });
    const user = userEvent.setup();
    renderApp("/account/passkeys");
    await user.click(await screen.findByRole("button", { name: t("passkeys.add") }));
    const add = await screen.findByRole("dialog");
    await user.type(within(add).getByLabelText(t("passkeys.nameLabel")), "Phone");
    await user.click(within(add).getByRole("button", { name: t("passkeys.create") }));

    const prompt = await screen.findByRole("dialog", { name: t("stepUp.title") });
    expect(within(prompt).getByText(t("stepUp.body"))).toBeInTheDocument();
    await user.type(within(prompt).getByLabelText(t("stepUp.password")), "my-password");
    await user.click(within(prompt).getByRole("button", { name: t("stepUp.verifyPassword") }));
    expect(mockAuth.client.opaque.stepUp).toHaveBeenCalledWith({ password: "my-password" });

    // the password is done; only the passkey is left
    expect(await within(prompt).findByText(t("stepUp.passwordVerified"))).toBeInTheDocument();
    expect(within(prompt).queryByLabelText(t("stepUp.password"))).not.toBeInTheDocument();
    expect(mockAuth.client.passkey.addPasskey).not.toHaveBeenCalled();
    await user.click(within(prompt).getByRole("button", { name: t("stepUp.verifyPasskey") }));
    await waitFor(() =>
      expect(mockAuth.client.passkey.addPasskey).toHaveBeenCalledWith({ name: "Phone" }),
    );
  });

  it("accepts either factor when one is enough (recovery)", async () => {
    const setMe = serveMe({ allowed: false, stale: ["password", "passkey"], oneOf: true });
    mockAuth.client.opaque.stepUp.mockImplementation(async () => {
      setMe(FRESH);
      return ok({ ok: true });
    });
    const user = userEvent.setup();
    renderApp("/account/passkeys");
    await user.click(await screen.findByRole("button", { name: t("passkeys.add") }));
    const add = await screen.findByRole("dialog");
    await user.type(within(add).getByLabelText(t("passkeys.nameLabel")), "Phone");
    await user.click(within(add).getByRole("button", { name: t("passkeys.create") }));

    const prompt = await screen.findByRole("dialog", { name: t("stepUp.title") });
    expect(within(prompt).getByText(t("stepUp.bodyOne"))).toBeInTheDocument();
    expect(within(prompt).getByRole("button", { name: t("stepUp.verifyPasskey") })).toBeVisible();
    await user.type(within(prompt).getByLabelText(t("stepUp.password")), "my-password");
    await user.click(within(prompt).getByRole("button", { name: t("stepUp.verifyPassword") }));
    await waitFor(() => expect(mockAuth.client.passkey.addPasskey).toHaveBeenCalled());
    expect(mockAuth.client.signIn.passkey).not.toHaveBeenCalled();
  });

  it("shows a wrong password and keeps asking", async () => {
    serveMe({ allowed: false, stale: ["password"], oneOf: false });
    mockAuth.client.opaque.stepUp.mockResolvedValue({
      data: null,
      error: { code: "INVALID_EMAIL_OR_PASSWORD", message: "Incorrect", status: 401 },
    });
    const user = userEvent.setup();
    renderApp("/account/app-passwords");
    await user.click(await screen.findByRole("button", { name: t("appPasswords.create") }));
    const create = await screen.findByRole("dialog");
    await user.type(within(create).getByLabelText(t("appPasswords.nameLabel")), "Thunderbird");
    await user.click(within(create).getByRole("button", { name: t("appPasswords.createSubmit") }));
    const prompt = await screen.findByRole("dialog", { name: t("stepUp.title") });
    await user.type(within(prompt).getByLabelText(t("stepUp.password")), "nope");
    await user.click(within(prompt).getByRole("button", { name: t("stepUp.verifyPassword") }));
    expect(await within(prompt).findByText(t("stepUp.wrongPassword"))).toBeInTheDocument();
    expect(mockAuth.client.apiKey.create).not.toHaveBeenCalled();
  });

  it("leaves the action undone and quiet when the user cancels", async () => {
    serveMe({ allowed: false, stale: ["passkey"], oneOf: false });
    const user = userEvent.setup();
    renderApp("/account/app-passwords");
    await user.click(await screen.findByRole("button", { name: t("appPasswords.create") }));
    const create = await screen.findByRole("dialog");
    await user.type(within(create).getByLabelText(t("appPasswords.nameLabel")), "Thunderbird");
    await user.click(within(create).getByRole("button", { name: t("appPasswords.createSubmit") }));
    const prompt = await screen.findByRole("dialog", { name: t("stepUp.title") });
    await user.click(within(prompt).getByRole("button", { name: t("common.cancel") }));
    await waitFor(() =>
      expect(screen.queryByRole("dialog", { name: t("stepUp.title") })).not.toBeInTheDocument(),
    );
    expect(mockAuth.client.apiKey.create).not.toHaveBeenCalled();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    // the create dialog is still there for another attempt
    expect(screen.getByLabelText(t("appPasswords.nameLabel"))).toHaveValue("Thunderbird");
  });

  it("prompts after a 403 REAUTHENTICATION_REQUIRED and retries the action", async () => {
    const setMe = serveMe(FRESH);
    mockAuth.client.apiKey.create
      .mockResolvedValueOnce({
        data: null,
        error: {
          code: "REAUTHENTICATION_REQUIRED",
          message: "Verify again",
          status: 403,
          stale: ["passkey"],
          oneOf: false,
        },
      })
      .mockResolvedValueOnce(ok({ id: "k1", key: "s8s_secret", name: "Thunderbird" }));
    mockAuth.client.signIn.passkey.mockImplementation(async () => {
      setMe(FRESH);
      return ok({ session: {} });
    });
    const user = userEvent.setup();
    renderApp("/account/app-passwords");
    await user.click(await screen.findByRole("button", { name: t("appPasswords.create") }));
    const create = await screen.findByRole("dialog");
    await user.type(within(create).getByLabelText(t("appPasswords.nameLabel")), "Thunderbird");
    await user.click(within(create).getByRole("button", { name: t("appPasswords.createSubmit") }));

    const prompt = await screen.findByRole("dialog", { name: t("stepUp.title") });
    expect(within(prompt).queryByLabelText(t("stepUp.password"))).not.toBeInTheDocument();
    await user.click(within(prompt).getByRole("button", { name: t("stepUp.verifyPasskey") }));
    expect(await screen.findByLabelText(t("appPasswords.keyLabel"))).toHaveValue("s8s_secret");
    expect(mockAuth.client.apiKey.create).toHaveBeenCalledTimes(2);
  });

  it("asks before removing a passkey when a factor is stale", async () => {
    const setMe = serveMe({ allowed: false, stale: ["passkey"], oneOf: false });
    mockAuth.client.passkey.listUserPasskeys.mockResolvedValue(
      ok([{ id: "p1", name: "Laptop", createdAt: "2026-09-01T10:00:00.000Z" }]),
    );
    mockAuth.client.signIn.passkey.mockImplementation(async () => {
      setMe(FRESH);
      return ok({ session: {} });
    });
    const user = userEvent.setup();
    renderApp("/account/passkeys");
    await user.click(
      await screen.findByRole("button", { name: t("passkeys.removeAria", { name: "Laptop" }) }),
    );
    const confirm = await screen.findByRole("alertdialog");
    await user.click(within(confirm).getByRole("button", { name: t("passkeys.remove") }));
    const prompt = await screen.findByRole("dialog", { name: t("stepUp.title") });
    expect(mockAuth.client.passkey.deletePasskey).not.toHaveBeenCalled();
    await user.click(within(prompt).getByRole("button", { name: t("stepUp.verifyPasskey") }));
    await waitFor(() =>
      expect(mockAuth.client.passkey.deletePasskey).toHaveBeenCalledWith({ id: "p1" }),
    );
  });

  it("does not prompt when the session is fresh", async () => {
    serveMe(FRESH);
    const user = userEvent.setup();
    renderApp("/account/app-passwords");
    await user.click(await screen.findByRole("button", { name: t("appPasswords.create") }));
    const create = await screen.findByRole("dialog");
    await user.type(within(create).getByLabelText(t("appPasswords.nameLabel")), "Thunderbird");
    await user.click(within(create).getByRole("button", { name: t("appPasswords.createSubmit") }));
    await waitFor(() => expect(mockAuth.client.apiKey.create).toHaveBeenCalledTimes(1));
    expect(screen.queryByRole("dialog", { name: t("stepUp.title") })).not.toBeInTheDocument();
  });
});
