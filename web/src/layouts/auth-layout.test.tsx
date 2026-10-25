import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router";
import { describe, expect, it } from "vitest";
import { RuntimeConfigProvider } from "@/config/runtime-config";
import { AuthLayout } from "@/layouts/auth-layout";
import { LoginPage } from "@/pages/login";
import { ThemeProvider } from "@/theme/theme";
import { parseRuntimeConfig } from "#shared";
import { t } from "@/i18n";

function renderLogin(config: unknown = {}) {
  return render(
    <RuntimeConfigProvider config={parseRuntimeConfig(config)}>
      <ThemeProvider>
        <MemoryRouter initialEntries={["/login"]}>
          <Routes>
            <Route element={<AuthLayout />}>
              <Route path="/login" element={<LoginPage />} />
            </Route>
          </Routes>
        </MemoryRouter>
      </ThemeProvider>
    </RuntimeConfigProvider>,
  );
}

const toggle = () => screen.getByRole("button", { name: t("theme.toggle") });

describe("AuthLayout", () => {
  it("renders the brand, the page title and the theme toggle", () => {
    renderLogin();
    expect(screen.getByRole("heading", { name: t("login.title") })).toBeInTheDocument();
    expect(screen.getByText("S8S Mail")).toBeInTheDocument();
    expect(screen.getByRole("img", { name: /S8S Mail logo/ })).toHaveTextContent("S");
    expect(screen.getByRole("button", { name: t("theme.toggle") })).toBeInTheDocument();
  });

  it("uses the configured app name and logos", () => {
    renderLogin({ appName: "Acme Mail", logoLightUrl: "/light.svg", logoDarkUrl: "/dark.svg" });
    expect(screen.getAllByAltText("Acme Mail logo")).toHaveLength(2);
  });

  it("toggles the dark class and remembers the choice across page loads", async () => {
    const reload = (view: ReturnType<typeof renderLogin>) => {
      view.unmount();
      document.documentElement.classList.remove("dark"); // a fresh page starts unstyled
      return renderLogin();
    };

    let view = renderLogin();
    await userEvent.click(toggle());
    expect(document.documentElement).toHaveClass("dark");

    view = reload(view);
    expect(document.documentElement).toHaveClass("dark");

    await userEvent.click(toggle());
    expect(document.documentElement).not.toHaveClass("dark");

    reload(view);
    expect(document.documentElement).not.toHaveClass("dark");
  });
});
