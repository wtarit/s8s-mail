import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { t } from "@/i18n";
import { iso } from "@/test/admin-fixtures";
import { mockAuth } from "@/test/auth-mock";
import { errorResponse, mockFetch, renderApp } from "@/test/helpers";

vi.mock("@/lib/auth-client", () => import("@/test/auth-mock").then((m) => m.authClientModule()));

describe("Admin / Domains", () => {
  // Load the lazy page chunk up front: under coverage instrumentation the cold import
  // can eat the whole findBy timeout of the first test when files run in parallel.
  beforeAll(async () => {
    await import("@/pages/admin/domains");
  }, 30_000);

  beforeEach(() => {
    mockAuth.reset();
    mockAuth.signInAs();
  });

  it("lists domains and only allows deleting unused ones", async () => {
    mockFetch({
      "GET /api/admin/domains": {
        domains: [
          { name: "example.com", addressCount: 3, catchAllAddress: null, createdAt: iso },
          { name: "example.org", addressCount: 0, catchAllAddress: null, createdAt: iso },
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

const addresses = {
  addresses: [
    { address: "ada@example.com", kind: "primary", accountName: "Ada Lovelace" },
    { address: "grace@example.com", kind: "primary", accountName: "Grace Hopper" },
    { address: "sales@example.org", kind: "alias", accountName: "Grace Hopper" },
  ],
};
const domains = (catchAll: string | null) => ({
  domains: [
    { name: "example.com", addressCount: 3, catchAllAddress: catchAll, createdAt: iso },
    { name: "example.org", addressCount: 1, catchAllAddress: null, createdAt: iso },
  ],
});

describe("Admin / Domains / Catch-all", () => {
  beforeEach(() => {
    mockAuth.reset();
    mockAuth.signInAs();
    // Radix Select needs these in jsdom
    Element.prototype.hasPointerCapture ??= () => false;
    Element.prototype.setPointerCapture ??= () => {};
    Element.prototype.releasePointerCapture ??= () => {};
    Element.prototype.scrollIntoView ??= () => {};
  });

  it("shows the catch-all address or Off per domain", async () => {
    mockFetch({
      "GET /api/admin/domains": {
        domains: [
          ...domains("sales@example.org").domains.slice(0, 1),
          ...domains(null).domains.slice(1),
        ],
      },
    });
    renderApp("/admin/domains");
    const table = await screen.findByRole("table");
    expect(
      within(table).getByRole("columnheader", { name: t("domains.colCatchAll") }),
    ).toBeInTheDocument();
    const rows = within(table).getAllByRole("row");
    expect(within(rows[1]!).getByText("sales@example.org")).toBeInTheDocument();
    expect(within(rows[2]!).getByText(t("domains.catchAllOff"))).toBeInTheDocument();
  });

  it("defaults to the admin's own primary address and saves it", async () => {
    const { calls } = mockFetch({
      "GET /api/admin/domains": domains(null),
      "GET /api/admin/addresses": addresses,
      "PATCH /api/admin/domains/example.com": domains("ada@example.com"),
    });
    const user = userEvent.setup();
    renderApp("/admin/domains");
    await user.click(
      await screen.findByRole("button", {
        name: t("domains.catchAllEditAria", { name: "example.com" }),
      }),
    );
    const dialog = await screen.findByRole("dialog");
    // reject is the default for a domain without a catch-all
    expect(within(dialog).getByRole("radio", { name: t("domains.catchAllReject") })).toBeChecked();
    await user.click(within(dialog).getByRole("radio", { name: t("domains.catchAllDeliver") }));
    expect(
      within(dialog).getByText(t("domains.catchAllDeliverHint", { domain: "example.com" })),
    ).toBeInTheDocument();
    expect(await within(dialog).findByRole("combobox")).toHaveTextContent("ada@example.com");

    await user.click(within(dialog).getByRole("button", { name: t("common.save") }));
    await waitFor(() =>
      expect(calls.find((c) => c.method === "PATCH")?.body).toEqual({
        catchAllAddress: "ada@example.com",
      }),
    );
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
  });

  it("saves a different chosen address", async () => {
    const { calls } = mockFetch({
      "GET /api/admin/domains": domains(null),
      "GET /api/admin/addresses": addresses,
      "PATCH /api/admin/domains/example.com": domains("sales@example.org"),
    });
    const user = userEvent.setup();
    renderApp("/admin/domains");
    await user.click(
      await screen.findByRole("button", {
        name: t("domains.catchAllEditAria", { name: "example.com" }),
      }),
    );
    const dialog = await screen.findByRole("dialog");
    await user.click(within(dialog).getByRole("radio", { name: t("domains.catchAllDeliver") }));
    await user.click(await within(dialog).findByRole("combobox"));
    await user.click(await screen.findByRole("option", { name: "sales@example.org" }));
    await user.click(within(dialog).getByRole("button", { name: t("common.save") }));
    await waitFor(() =>
      expect(calls.find((c) => c.method === "PATCH")?.body).toEqual({
        catchAllAddress: "sales@example.org",
      }),
    );
  });

  it("clears the catch-all by choosing to reject", async () => {
    const { calls } = mockFetch({
      "GET /api/admin/domains": domains("grace@example.com"),
      "GET /api/admin/addresses": addresses,
      "PATCH /api/admin/domains/example.com": domains(null),
    });
    const user = userEvent.setup();
    renderApp("/admin/domains");
    await user.click(
      await screen.findByRole("button", {
        name: t("domains.catchAllEditAria", { name: "example.com" }),
      }),
    );
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByRole("radio", { name: t("domains.catchAllDeliver") })).toBeChecked();
    expect(await within(dialog).findByRole("combobox")).toHaveTextContent("grace@example.com");
    await user.click(within(dialog).getByRole("radio", { name: t("domains.catchAllReject") }));
    await user.click(within(dialog).getByRole("button", { name: t("common.save") }));
    await waitFor(() =>
      expect(calls.find((c) => c.method === "PATCH")?.body).toEqual({ catchAllAddress: null }),
    );
  });

  it("shows the server error inside the dialog", async () => {
    mockFetch({
      "GET /api/admin/domains": domains(null),
      "GET /api/admin/addresses": addresses,
      "PATCH /api/admin/domains/example.com": () =>
        errorResponse(400, "invalid_catch_all", "The catch-all must be an existing address"),
    });
    const user = userEvent.setup();
    renderApp("/admin/domains");
    await user.click(
      await screen.findByRole("button", {
        name: t("domains.catchAllEditAria", { name: "example.com" }),
      }),
    );
    const dialog = await screen.findByRole("dialog");
    await user.click(within(dialog).getByRole("radio", { name: t("domains.catchAllDeliver") }));
    await user.click(within(dialog).getByRole("button", { name: t("common.save") }));
    expect(
      await within(dialog).findByText("The catch-all must be an existing address"),
    ).toBeInTheDocument();
  });
});
