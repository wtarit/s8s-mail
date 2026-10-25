import { screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { leaveApp } from "@/lib/navigation";
import { mockAuth } from "@/test/auth-mock";
import { renderApp } from "@/test/helpers";

vi.mock("@/lib/auth-client", () => import("@/test/auth-mock").then((m) => m.authClientModule()));
vi.mock("@/lib/navigation", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  leaveApp: vi.fn(),
}));

describe("RootPage", () => {
  beforeEach(() => {
    mockAuth.reset();
    vi.mocked(leaveApp).mockClear();
  });

  it("goes to the webmail when the runtime config names one", async () => {
    renderApp("/", { config: { webmailUrl: "/webmail/" } });
    await waitFor(() => expect(leaveApp).toHaveBeenCalledWith("/webmail/"));
  });

  it("goes to the account without a webmail", async () => {
    renderApp("/");
    await waitFor(() => expect(screen.getByTestId("location").textContent).not.toBe("/"));
    expect(screen.getByTestId("location").textContent).toMatch(
      /account%2Fprofile|\/account\/profile/,
    );
    expect(leaveApp).not.toHaveBeenCalled();
  });
});
