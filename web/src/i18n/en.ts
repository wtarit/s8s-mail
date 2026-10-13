/**
 * The single English message catalog. Every user-visible string lives here, keyed by a
 * dotted id; components never contain inline text. `{name}` placeholders are filled by t().
 * To add a locale later, add a file with the same keys (`satisfies Messages`) and select it.
 */
export const en = {
  "app.loading": "Loading…",
  "app.configError": "Could not load the application configuration.",

  "brand.logoAlt": "{appName} logo",

  "theme.toggle": "Toggle theme",
  "theme.light": "Light",
  "theme.dark": "Dark",

  "authLayout.footer": "{domain}",

  "nav.account": "Account",
  "nav.admin": "Admin",
  "nav.profile": "Profile",
  "nav.passkeys": "Passkeys",
  "nav.appPasswords": "App passwords",
  "nav.sessions": "Sessions",
  "nav.recovery": "Recovery email",
  "nav.users": "Users",
  "nav.domains": "Domains",
  "nav.clients": "Sign-in apps",
  "nav.openMenu": "Open navigation",

  "userMenu.label": "Account menu",
  "userMenu.placeholderEmail": "user@example.com",
  "userMenu.theme": "Theme",
  "userMenu.signOut": "Sign out",

  "login.title": "Sign in",
  "invite.title": "Welcome",
  "magicLinkSent.title": "Check your email",
  "magicLinkVerify.title": "Signing you in",
  "consent.title": "Authorize application",
  "error.title": "Something went wrong",
  "notFound.title": "Page not found",

  "profile.title": "Profile",
  "passkeys.title": "Passkeys",
  "appPasswords.title": "App passwords",
  "sessions.title": "Sessions",
  "recovery.title": "Recovery email",

  "adminUsers.title": "Users",
  "adminDomains.title": "Domains",
  "adminClients.title": "Sign-in apps",
} as const;

export type MessageKey = keyof typeof en;
export type Messages = Record<MessageKey, string>;
