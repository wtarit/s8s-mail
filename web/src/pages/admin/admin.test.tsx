import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { t } from "@/i18n";
import { mockAuth } from "@/test/auth-mock";
import { errorResponse, mockFetch, renderApp } from "@/test/helpers";

vi.mock("@/lib/auth-client", () => import("@/test/auth-mock").then((m) => m.authClientModule()));

const iso = "2026-10-01T10:00:00.000Z";
const ada = {
  id: "u1",
  name: "Ada Lovelace",
  email: "ada@example.com",
  role: "admin",
  status: "active",
  aliasCount: 2,
  recoveryEmail: "ada@example.org",
  lastSignInAt: iso,
  createdAt: iso,
};
const grace = {
  ...ada,
  id: "u2",
  name: "Grace Hopper",
  email: "grace@example.com",
  role: "user",
  status: "invited",
  aliasCount: 0,
  lastSignInAt: null,
};

describe("Admin / Users", () => {
  beforeEach(() => {
    mockAuth.reset();
    mockAuth.signInAs();
  });

  it("lists users with alias count, role, last sign-in and status", async () => {
    mockFetch({ "GET /api/admin/users": { users: [ada, grace] } });
    renderApp("/admin/users");
    const table = await screen.findByRole("table");
    const rows = within(table).getAllByRole("row");
    expect(rows).toHaveLength(3);
    expect(within(rows[1]!).getByText("Ada Lovelace")).toBeInTheDocument();
    expect(within(rows[1]!).getByText("ada@example.com")).toBeInTheDocument();
    expect(within(rows[1]!).getByText("2")).toBeInTheDocument();
    expect(within(rows[1]!).getByText(t("status.active"))).toBeInTheDocument();
    expect(within(rows[2]!).getByText(t("users.never"))).toBeInTheDocument();
    expect(within(rows[2]!).getByText(t("status.invited"))).toBeInTheDocument();
  });

  it("shows an empty state with one action", async () => {
    mockFetch({ "GET /api/admin/users": { users: [] } });
    renderApp("/admin/users");
    expect(await screen.findByText(t("users.empty"))).toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: t("users.new") })).toHaveLength(1);
  });

  it("shows an error state instead of crashing when the API fails", async () => {
    mockFetch({
      "GET /api/admin/users": () => errorResponse(500, "internal", "Database unavailable"),
    });
    renderApp("/admin/users");
    expect(await screen.findByText("Database unavailable")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: t("common.retry") })).toBeInTheDocument();
  });

  it("creates a user and shows the invite link from the response", async () => {
    const inviteUrl = "https://mail.example.com/invite/tok-abc123";
    const { calls } = mockFetch({
      "GET /api/admin/users": { users: [ada] },
      "POST /api/admin/users": () => ({
        user: { ...grace, name: "Grace Hopper" },
        invite: { url: inviteUrl, expiresAt: "2026-10-15T10:00:00.000Z" },
      }),
    });
    const user = userEvent.setup();
    renderApp("/admin/users");
    await user.click(await screen.findByRole("button", { name: t("users.new") }));

    const dialog = await screen.findByRole("dialog");
    await user.type(within(dialog).getByLabelText(t("users.name")), "Grace Hopper");
    await user.type(within(dialog).getByLabelText(t("users.primaryAddress")), "Grace@Example.com");
    await user.type(within(dialog).getByLabelText(t("users.recoveryEmail")), "grace@example.org");
    await user.click(within(dialog).getByRole("button", { name: t("users.createSubmit") }));

    const post = calls.find((c) => c.method === "POST" && c.path === "/api/admin/users");
    expect(post?.body).toEqual({
      name: "Grace Hopper",
      primaryAddress: "Grace@Example.com",
      recoveryEmail: "grace@example.org",
      role: "user",
    });

    const field = await within(dialog).findByLabelText(t("invite.linkLabel"));
    expect(field).toHaveValue(inviteUrl);
    expect(within(dialog).getByText(/The link expires on/)).toBeInTheDocument();
    expect(within(dialog).getByText(/works once/)).toBeInTheDocument();

    await user.click(within(dialog).getByRole("button", { name: t("copyField.copy") }));
    expect(await navigator.clipboard.readText()).toBe(inviteUrl);

    await user.click(within(dialog).getByRole("button", { name: t("common.done") }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(screen.queryByDisplayValue(inviteUrl)).not.toBeInTheDocument();
  });

  it("validates the new-user form before posting", async () => {
    const { calls } = mockFetch({ "GET /api/admin/users": { users: [ada] } });
    const user = userEvent.setup();
    renderApp("/admin/users");
    await user.click(await screen.findByRole("button", { name: t("users.new") }));
    const dialog = await screen.findByRole("dialog");
    await user.click(within(dialog).getByRole("button", { name: t("users.createSubmit") }));
    expect(await within(dialog).findByText(t("users.nameRequired"))).toBeInTheDocument();
    expect(within(dialog).getAllByText(t("users.addressInvalid"))).not.toHaveLength(0);
    expect(calls.some((c) => c.method === "POST")).toBe(false);
  });

  it("deletes a user only after confirming by name", async () => {
    const { calls } = mockFetch({
      "GET /api/admin/users": { users: [ada, grace] },
      "DELETE /api/admin/users/u2": {},
    });
    const user = userEvent.setup();
    renderApp("/admin/users");
    await user.click(
      await screen.findByRole("button", { name: t("users.actionsFor", { name: "Grace Hopper" }) }),
    );
    await user.click(await screen.findByRole("menuitem", { name: t("users.actionDelete") }));
    const dialog = await screen.findByRole("alertdialog");
    expect(
      within(dialog).getByText(t("users.deleteTitle", { name: "Grace Hopper" })),
    ).toBeInTheDocument();
    expect(calls.some((c) => c.method === "DELETE")).toBe(false);
    await user.click(within(dialog).getByRole("button", { name: t("users.actionDelete") }));
    await waitFor(() =>
      expect(calls.some((c) => c.method === "DELETE" && c.path === "/api/admin/users/u2")).toBe(
        true,
      ),
    );
  });

  it("does not offer to disable or delete yourself", async () => {
    mockFetch({ "GET /api/admin/users": { users: [ada] } });
    const user = userEvent.setup();
    renderApp("/admin/users");
    await user.click(
      await screen.findByRole("button", { name: t("users.actionsFor", { name: "Ada Lovelace" }) }),
    );
    expect(
      await screen.findByRole("menuitem", { name: t("users.actionEdit") }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("menuitem", { name: t("users.actionDelete") }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("menuitem", { name: t("users.actionDisable") }),
    ).not.toBeInTheDocument();
  });

  it("generates a fresh invite link for an existing user", async () => {
    mockFetch({
      "GET /api/admin/users": { users: [ada, grace] },
      "POST /api/admin/users/u2/invite": {
        invite: {
          url: "https://mail.example.com/invite/new-token",
          expiresAt: "2026-10-20T00:00:00.000Z",
        },
      },
    });
    const user = userEvent.setup();
    renderApp("/admin/users");
    await user.click(
      await screen.findByRole("button", { name: t("users.actionsFor", { name: "Grace Hopper" }) }),
    );
    await user.click(await screen.findByRole("menuitem", { name: t("users.actionInvite") }));
    const dialog = await screen.findByRole("dialog");
    await user.click(within(dialog).getByRole("button", { name: t("users.inviteGenerate") }));
    expect(await within(dialog).findByLabelText(t("invite.linkLabel"))).toHaveValue(
      "https://mail.example.com/invite/new-token",
    );
  });
});

describe("Admin / Domains", () => {
  beforeEach(() => {
    mockAuth.reset();
    mockAuth.signInAs();
  });

  it("lists domains and only allows deleting unused ones", async () => {
    mockFetch({
      "GET /api/admin/domains": {
        domains: [
          { name: "example.com", addressCount: 3, createdAt: iso },
          { name: "example.org", addressCount: 0, createdAt: iso },
        ],
      },
    });
    renderApp("/admin/domains");
    expect(await screen.findByText("example.com")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: t("domains.deleteAria", { name: "example.com" }) }),
    ).toBeDisabled();
    expect(
      screen.getByRole("button", { name: t("domains.deleteAria", { name: "example.org" }) }),
    ).toBeEnabled();
  });

  it("adds a domain", async () => {
    const { calls } = mockFetch({
      "GET /api/admin/domains": { domains: [] },
      "POST /api/admin/domains": {},
    });
    const user = userEvent.setup();
    renderApp("/admin/domains");
    await user.click(await screen.findByRole("button", { name: t("domains.add") }));
    const dialog = await screen.findByRole("dialog");
    await user.type(within(dialog).getByLabelText(t("domains.nameLabel")), "Mail.Example.com");
    await user.click(within(dialog).getByRole("button", { name: t("domains.addSubmit") }));
    await waitFor(() =>
      expect(calls.find((c) => c.method === "POST")?.body).toEqual({ name: "mail.example.com" }),
    );
  });
});

describe("Admin / Sign-in apps", () => {
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
