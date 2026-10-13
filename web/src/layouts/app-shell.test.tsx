import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { describe, expect, it } from "vitest";
import { AppRoutes } from "@/App";
import { RuntimeConfigProvider } from "@/config/runtime-config";
import { t } from "@/i18n";
import { ThemeProvider } from "@/theme/theme";
import { DEFAULT_RUNTIME_CONFIG } from "@s8s/shared";

describe("AppShell", () => {
  it("renders the account and admin navigation around a page", () => {
    render(
      <RuntimeConfigProvider config={DEFAULT_RUNTIME_CONFIG}>
        <ThemeProvider>
          <MemoryRouter initialEntries={["/account/passkeys"]}>
            <AppRoutes />
          </MemoryRouter>
        </ThemeProvider>
      </RuntimeConfigProvider>,
    );
    expect(screen.getByRole("heading", { name: t("passkeys.title") })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: t("nav.appPasswords") })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: t("nav.users") })).toBeInTheDocument();
  });
});
