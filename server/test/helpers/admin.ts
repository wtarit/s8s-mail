import { request, type Json, type Session } from "./index";

export async function createUser(admin: Session, over: Record<string, unknown> = {}) {
  return request<{ user: Json; invite: { url: string; expiresAt: string } }>("/api/admin/users", {
    method: "POST",
    cookie: admin.cookie,
    json: {
      name: "Ana",
      primaryAddress: "Ana@Example.com",
      recoveryEmail: "ana.recovery@example.org",
      ...over,
    },
  });
}
