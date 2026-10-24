import { DEFAULT_RUNTIME_CONFIG, parseRuntimeConfig, type MeResponse } from "@s8s/shared";
import { render } from "@testing-library/react";
import { MemoryRouter, useLocation } from "react-router";
import { vi } from "vitest";
import { AppRoutes } from "@/App";
import { RuntimeConfigProvider } from "@/config/runtime-config";
import { TooltipProvider } from "@/components/ui/tooltip";
import { Toaster } from "@/components/ui/sonner";
import { ThemeProvider } from "@/theme/theme";

function LocationProbe() {
  const location = useLocation();
  return <output data-testid="location">{location.pathname + location.search}</output>;
}

export function renderApp(route: string, options: { config?: unknown; state?: unknown } = {}) {
  const config = options.config ? parseRuntimeConfig(options.config) : DEFAULT_RUNTIME_CONFIG;
  return render(
    <RuntimeConfigProvider config={config}>
      <ThemeProvider>
        <TooltipProvider>
          <MemoryRouter
            initialEntries={[
              {
                pathname: route.split("?")[0] ?? route,
                search: route.includes("?") ? `?${route.split("?")[1]}` : "",
                state: options.state,
              },
            ]}
          >
            <AppRoutes />
            <LocationProbe />
          </MemoryRouter>
          <Toaster />
        </TooltipProvider>
      </ThemeProvider>
    </RuntimeConfigProvider>,
  );
}

type Handler = (request: { body: unknown; url: URL }) => unknown | Response;

export const ME_ADMIN = {
  user: {
    id: "u1",
    name: "Ada Lovelace",
    email: "ada@example.com",
    role: "admin",
    recoveryEmailMasked: "a•••@example.org",
    hasPassword: true,
    passkeyCount: 0,
    factors: {
      password: { verifiedAt: "2026-10-22T10:00:00.000Z", fresh: true },
      passkey: { verifiedAt: null, fresh: false },
      recovery: { verifiedAt: null, fresh: false },
    },
    accountChange: { allowed: true, stale: [], oneOf: false, currentPasswordRequired: true },
  },
  accounts: [
    {
      id: "a1",
      name: "Ada Lovelace",
      isPersonal: true,
      addresses: [{ address: "ada@example.com", kind: "primary" }],
    },
  ],
};

/** `ME_USER` with `accountChange` overridden (e.g. stale factors, or no current password needed). */
export function meWithAccountChange(accountChange: Partial<MeResponse["user"]["accountChange"]>) {
  return {
    ...ME_USER,
    user: {
      ...ME_USER.user,
      accountChange: { ...ME_USER.user.accountChange, ...accountChange },
    },
  };
}

export const ME_USER = { ...ME_ADMIN, user: { ...ME_ADMIN.user, role: "user" } };

/**
 * Replace `fetch` with a router keyed by "METHOD /path". Handlers return JSON bodies
 * (status 200), or a `Response` for other statuses. Unknown routes answer 404.
 * `GET /api/me` defaults to an admin.
 */
export function mockFetch(routes: Record<string, Handler | unknown> = {}) {
  const table: Record<string, Handler | unknown> = { "GET /api/me": ME_ADMIN, ...routes };
  const calls: Array<{ method: string; path: string; body: unknown }> = [];
  const fn = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(
      typeof input === "string" ? input : input instanceof URL ? input.href : input.url,
    );
    const method = init?.method ?? "GET";
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ method, path: url.pathname, body });
    const entry = table[`${method} ${url.pathname}`];
    if (entry === undefined) {
      return Response.json({ error: { code: "not_found", message: "Not found" } }, { status: 404 });
    }
    const result = typeof entry === "function" ? (entry as Handler)({ body, url }) : entry;
    if (result instanceof Response) return result;
    return Response.json(result ?? {});
  });
  vi.stubGlobal("fetch", fn);
  return { fn, calls };
}

export function errorResponse(status: number, code: string, message: string) {
  return Response.json({ error: { code, message } }, { status });
}
