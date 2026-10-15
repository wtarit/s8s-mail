import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { t } from "@/i18n";
import { iso } from "@/test/admin-fixtures";
import { mockAuth } from "@/test/auth-mock";
import { mockFetch, renderApp } from "@/test/helpers";

vi.mock("@/lib/auth-client", () => import("@/test/auth-mock").then((m) => m.authClientModule()));

describe("Admin / Sign-in apps", () => {
  // Load the lazy page chunk up front: under coverage instrumentation the cold import
  // can eat the whole findBy timeout of the first test when files run in parallel.
  beforeAll(async () => {
    await import("@/pages/admin/clients");
  }, 30_000);

  beforeEach(() => {
    mockAuth.reset();
    mockAuth.signInAs();
  });

  it("creates a confidential client and shows its secret once", async () => {
    const { calls } = mockFetch({
      "GET /api/admin/oauth-clients": { clients: [] },
      "POST /api/admin/oauth-clients": () => ({
        client: {
          clientId: "client-123",
          name: "Wiki",
          redirectUris: ["https://wiki.example.com/cb"],
          trusted: false,
          public: false,
          createdAt: iso,
        },
        clientSecret: "shh-secret-value",
      }),
    });
    const user = userEvent.setup();
    renderApp("/admin/clients");
    await user.click(await screen.findByRole("button", { name: t("clients.create") }));
    const dialog = await screen.findByRole("dialog");
    await user.type(within(dialog).getByLabelText(t("clients.nameLabel")), "Wiki");
    await user.type(
      within(dialog).getByLabelText(t("clients.urisLabel")),
      "https://wiki.example.com/cb",
    );
    await user.click(within(dialog).getByRole("switch", { name: t("clients.publicLabel") }));
    await user.click(within(dialog).getByRole("button", { name: t("clients.createSubmit") }));

    expect(calls.find((c) => c.method === "POST")?.body).toEqual({
      name: "Wiki",
      redirectUris: ["https://wiki.example.com/cb"],
      trusted: false,
      public: false,
    });
    expect(await within(dialog).findByLabelText(t("clients.clientSecret"))).toHaveValue(
      "shh-secret-value",
    );
    expect(within(dialog).getByText(t("clients.secretOnce"))).toBeInTheDocument();
    await user.click(within(dialog).getByRole("button", { name: t("common.done") }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(screen.queryByDisplayValue("shh-secret-value")).not.toBeInTheDocument();
  });
});
