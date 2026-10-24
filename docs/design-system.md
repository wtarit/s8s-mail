# Design system: `web/` (auth, account, admin SPA)

Status: **approved** (2026-10-12). Binding for `web/`.

Goal: login → consent → Bulwark webmail should feel like **one product**. We match Bulwark's existing visual language (read from `../s8s-mail-webmail`, v1.14.2) rather than inventing our own. We copy token *values*, not Bulwark code.

## 1. Principles

- **Quiet and utilitarian.** Neutral surfaces, one accent, no decoration. These are pages people pass through, not dwell on.
- **Same feel as Bulwark.** Same palette, radius, control heights, icon set and font stack.
- **Light + dark.** Follow the OS by default, with a manual toggle. A `.dark` class on `<html>`, as in Bulwark.
- **Accessible by default.** WCAG 2.2 AA contrast, visible focus rings (`ring` token), every action keyboard-reachable, labels on every input. Never rely on colour alone.
- **Mobile-first layouts.** Auth pages must work at 360 px width.
- **Branding is runtime config.** App name and light/dark logo URLs come from `config.json`, like Bulwark's `APP_NAME` / `APP_LOGO_*_URL`, never from build constants.

## 2. Tokens

We use **shadcn/ui's token names** (`--background`, `--primary`, …), so `shadcn add` components work unmodified. Tailwind v4 maps them through `@theme inline`. The values are Bulwark's.

Light mode uses a slate neutral palette with a blue-500 primary. Dark mode uses a neutral palette, and its primary is near-white, as in Bulwark.

| Token | Light | Dark | Use |
|---|---|---|---|
| `background` | `#ffffff` | `#0a0a0a` | page |
| `foreground` | `#0f172a` | `#fafafa` | body text |
| `card` | `#ffffff` | `#141414` | cards, auth panel |
| `popover` | `#ffffff` | `#1c1c1c` | menus, dialogs |
| `primary` | `#3b82f6` | `#fafafa` | primary button, links |
| `primary-foreground` | `#ffffff` | `#171717` | text on primary |
| `secondary` | `#f8fafc` | `#262626` | secondary button |
| `muted` | `#f1f5f9` | `#262626` | input fill, subtle bg |
| `muted-foreground` | `#64748b` | `#a3a3a3` | helper text |
| `accent` | `#dbeafe` | `#1e3a8a` | hover/selected rows |
| `accent-foreground` | `#1e40af` | `#dbeafe` | text on accent |
| `destructive` | `#ef4444` | `#ef4444` | delete, revoke |
| `success` | `#22c55e` | `#16a34a` | confirmations |
| `warning` | `#eab308` | `#ca8a04` | expiring invite etc. |
| `info` | `#3b82f6` | `#60a5fa` | notices |
| `border` / `input` | `#e2e8f0` | `rgba(128,128,128,.3)` / `#262626` | hairlines |
| `ring` | `#94a3b8` | `#d4d4d4` | focus ring |
| `sidebar` | `#f8fafc` | `#0a0a0a` | app-shell nav |

`success`, `warning` and `info` are extra tokens that Bulwark has and shadcn doesn't. Add them to `@theme inline`.

### Radius

`--radius: 0.75rem`. shadcn derives the others from it:

| Class | Size | Use |
|---|---|---|
| `rounded-sm` | 8px | badges |
| `rounded-md` | 10px | app-shell controls |
| `rounded-lg` | 12px | auth inputs and buttons, as in Bulwark's login |
| `rounded-xl` | 16px | auth card |

### Typography

- **Font:** the system UI stack, exactly as Bulwark's body:
  `-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, "Noto Sans Thai", "Leelawadee UI", Tahoma, sans-serif`.
  No web-font download (Thai coverage included).
- **Mono:** `ui-monospace, SFMono-Regular, Menlo, Consolas, monospace`. Used for invite links, app passwords and client IDs.
- **Scale:**

  | Style | Classes |
  |---|---|
  | Page title (auth card) | `text-2xl` (24) / semibold |
  | Section title (app shell) | `text-lg` (18) / semibold |
  | Body (app shell) | `text-sm` (14) |
  | Body (auth pages) | `text-[15px]` |
  | Helper | `text-[13px]` + `muted-foreground` |

- Weights: 400 and 600 only (500 for buttons).

### Spacing, size, elevation

- Tailwind's 4 px scale.
- **Control heights:** `h-11` on auth pages (Bulwark's login); `h-9`/`h-10` in the app shell.
- **Auth card:** `max-w-[440px]`, `p-8` (`p-6` below 400 px), `rounded-xl`, `border border-border/60`, `shadow-xl shadow-black/5` (`dark:shadow-black/20`).
- **App shell:** sidebar 240 px (collapses to a sheet below 768 px), content `max-w-4xl`, section gap `gap-8`.

### Icons

- **Tabler** (`@tabler/icons-react`), outline style, `size={18}` inline / `20` in nav, `stroke={1.75}`. Same set as Bulwark.
- Configure shadcn to use Tabler instead of its default lucide.

## 3. Components (shadcn/ui)

| Group | Components |
|---|---|
| Form | `button`, `input`, `label`, `form` (react-hook-form + Zod resolver, schemas from `shared/`), `checkbox`, `switch`, `select` |
| Surfaces | `card`, `dialog`, `alert-dialog`, `sheet`, `separator`, `tabs` |
| Data | `table`, `badge`, `avatar`, `skeleton` |
| Feedback | `sonner` (toasts), `alert`, `tooltip` |
| Navigation | `sidebar`, `dropdown-menu`, `breadcrumb` |

Custom components, built on the above:
- `CopyField`: mono value + copy button. Used for invite links, app passwords and client secrets. Show once, with a warning.
- `PasskeyList`: name, created and last-used dates, rename, remove.
- `ScopeList`: the consent screen's human-readable list of requested scopes.
- `EmptyState`: icon, one line, one action.

### Button hierarchy

- One **primary** action per view.
- Secondary actions are `outline`; tertiary actions are `ghost`.
- **Destructive** buttons (revoke, delete user) always confirm via `alert-dialog` that names the object.

## 4. Page templates

**AuthLayout:** a centered card on `background`.
- Logo or app name above the card.
- A footer with the deployment's domain and a theme toggle.
- Used by:

  | Route | Purpose |
  |---|---|
  | `/login` | sign in |
  | `/invite/:token` | invite welcome and passkey registration |
  | `/magic-link/sent` | "check your email" |
  | `/magic-link/verify` | redeem a magic link |
  | `/consent` | OAuth consent |
  | `/error` | error page |

**AppShell:** a sidebar plus a content column.
- The header has a user menu: email, theme, sign out.
- Sidebar groups:
  - **Account:** Profile, Passkeys, App passwords, Sessions, Recovery email.
  - **Admin** (role-gated): Users, Domains, Sign-in apps (OAuth clients).

## 5. Key screens (behaviour)

- **Login:**
  1. Email field, then primary **"Sign in with passkey"**. Passkey autofill (conditional UI) when the browser supports it.
  2. A password field with **"Sign in"** below it.
  3. Secondary **"Email me a sign-in link"**. The confirmation copy says the link goes to the **recovery address** (masked, e.g. `b•••@gmail.com`), never the mailbox.
- **Invite:**
  1. "Welcome, {name}".
  2. Register a passkey; the user names the device.
  3. Done → continue to webmail or account.
  - Expired or used invites show an explanation and say to ask the admin.
- **Consent:**
  - Client name and logo, the signed-in user, and the scope list.
  - Primary "Allow", outline "Deny".
  - First-party clients such as Bulwark skip this screen.
- **Admin → Users:**
  - Table: name, primary address, aliases count, role, last sign-in, status.
  - Primary **"New user"** opens a dialog: name, primary address, recovery email, role.
  - The result view shows the **invite link in a `CopyField`**, with its expiry.
  - Row actions: new invite, edit aliases, disable, delete.
- **Account → App passwords:** create (with a name) → show the key once in `CopyField` → the list shows name, created and last-used dates, and revoke.

## 6. Resolved points

- i18n: English only first. All strings live in one catalog so locales can be added.
- Default branding: name "S8S Mail", logo = letter "S" mark on `primary`.
