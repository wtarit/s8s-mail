import { vi } from "vitest";
import type * as AuthClientModule from "@/lib/auth-client";

type AuthResult = {
  data: unknown;
  error: null | { message?: string; code?: string; status?: number };
};
const ok = (data: unknown = {}): AuthResult => ({ data, error: null });

/**
 * Stand-in for the Better Auth client module. Tests mock `@/lib/auth-client` with
 * `authClientModule()` and drive behaviour through `mockAuth`.
 */
export const mockAuth = {
  session: { data: null as unknown, isPending: false },
  client: {
    signIn: { email: vi.fn(), passkey: vi.fn(), magicLink: vi.fn() },
    signOut: vi.fn(),
    listSessions: vi.fn(),
    revokeSession: vi.fn(),
    revokeOtherSessions: vi.fn(),
    passkey: {
      addPasskey: vi.fn(),
      listUserPasskeys: vi.fn(),
      updatePasskey: vi.fn(),
      deletePasskey: vi.fn(),
    },
    apiKey: { create: vi.fn(), list: vi.fn(), delete: vi.fn() },
    oauth2: { consent: vi.fn(), publicClient: vi.fn() },
    magicLink: { verify: vi.fn() },
  },
  /** Reset every mock to a harmless success and sign the user out. */
  reset() {
    mockAuth.session = { data: null, isPending: false };
    const c = mockAuth.client;
    const fns = [
      c.signIn.email,
      c.signIn.passkey,
      c.signIn.magicLink,
      c.signOut,
      c.revokeSession,
      c.revokeOtherSessions,
      c.passkey.addPasskey,
      c.passkey.updatePasskey,
      c.passkey.deletePasskey,
      c.apiKey.delete,
      c.oauth2.consent,
      c.magicLink.verify,
    ];
    for (const fn of fns) fn.mockReset().mockResolvedValue(ok());
    c.listSessions.mockReset().mockResolvedValue(ok([]));
    c.passkey.listUserPasskeys.mockReset().mockResolvedValue(ok([]));
    c.apiKey.list.mockReset().mockResolvedValue(ok({ apiKeys: [] }));
    c.apiKey.create.mockReset().mockResolvedValue(ok({ id: "k1", key: "secret" }));
    c.oauth2.publicClient.mockReset().mockResolvedValue(ok({ client_name: "Webmail" }));
  },
  signInAs(user: { id?: string; name?: string; email?: string } = {}, token = "tok-current") {
    mockAuth.session = {
      data: {
        user: { id: "u1", name: "Ada Lovelace", email: "ada@example.com", ...user },
        session: { id: "s1", token },
      },
      isPending: false,
    };
  },
};

/** Factory for `vi.mock("@/lib/auth-client", ...)`: real helpers, fake client. */
export async function authClientModule() {
  const actual = await vi.importActual<typeof AuthClientModule>("@/lib/auth-client");
  return {
    ...actual,
    getAuthClient: () => mockAuth.client,
    useAuthSession: () => mockAuth.session,
  };
}

mockAuth.reset();
