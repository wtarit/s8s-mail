export const iso = "2026-10-01T10:00:00.000Z";
export const ada = {
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
export const grace = {
  ...ada,
  id: "u2",
  name: "Grace Hopper",
  email: "grace@example.com",
  role: "user",
  status: "invited",
  aliasCount: 0,
  lastSignInAt: null,
};
