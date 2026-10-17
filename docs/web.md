# Web app and shared UI

The product's screens are written **once** and shown on web and mobile. This page explains how, and how to extend it.

## The layers

```
apps/web, apps/mobile      thin: a router adapter + one route per screen
        |
packages/features          screens + the logic behind them (session, forms, queries, permissions)
        |
packages/ui                components with variants, design tokens, theme (React Native primitives)
        |
packages/api-client, contracts, domain     typed API, schemas, pure rules
```

- **`packages/ui`** knows nothing about the API. It is components only: `Button`, `TextField`, `SelectField`, `Dialog`, `FormDialog`, `ConfirmDialog`, `DataTable`, `Tabs`, `Toast`, `Alert`, `Badge`, `Card`/`Section`, `Stack`/`Row`, `Link`/`NavLink`, `Screen`, `PageHeader`, and more (see `src/index.ts`).
- **`packages/features`** is where product behaviour lives. Each screen (`LoginScreen`, `ProductsScreen`, `InventoryScreen`, ...) is a React component taking plain props such as `token` or `id`. `AppProviders` wraps everything a screen expects (theme, navigation, API runtime, query cache, toasts, auth).
- **Apps** only provide platform glue. The web app's is `apps/web/components/providers.tsx` (Next's router behind the shared `Navigation` interface) and one-line route files such as `apps/web/app/(app)/products/page.tsx`.

Both packages are **source packages**: apps compile them (Next via `transpilePackages`, Metro natively). On the web, `react-native` is aliased to `react-native-web`.

## Components with variants

Every look is declared once with `createVariants` (views) or `createTextVariants` (text and inputs), reading colours and sizes from `tokens.ts`:

```ts
const useCardStyle = createVariants((t) => ({
  base: { borderRadius: radius.lg },
  variants: { variant: { outlined: {...}, filled: {...} }, padding: { sm: {...}, md: {...} } },
  defaults: { variant: 'outlined', padding: 'md' },
}));
```

To add a component: put it in `packages/ui/src`, give it variants rather than one-off styles, export it from `index.ts`, and add a test next to it. To restyle the product, change `tokens.ts`.

### One implementation or two?

Most components are one file that works on both platforms. Where the platforms genuinely differ there are two files with the same name, and the bundler picks the right one:

| Component       | `Foo.tsx` (native)                      | `Foo.web.tsx` (web)                                             |
| --------------- | --------------------------------------- | --------------------------------------------------------------- |
| `ThemeProvider` | follows the device's light/dark setting | CSS variables, so server and client HTML match                  |
| `Form`          | a grouping `View`                       | a real `<form>` (Enter submits, password managers work)         |
| `Dialog`        | the system modal                        | the browser's `<dialog>` (focus trap, Escape, inert background) |
| `SelectField`   | a field that opens a list               | a native `<select>`                                             |
| `Screen`        | a scrolling screen                      | the page itself scrolls                                         |
| `SkipLink`      | nothing                                 | "Skip to content" link                                          |

**Rule:** a `.web` file must never import its native sibling by name (`./Foo` resolves to itself on the web and the compiler hangs). Share code through a third neutral file (`themeContext.ts`, `formContext.ts`, `dialogTypes.ts`). `pnpm check:boundaries` fails if this is violated.

### Gotchas worth knowing

- Text must be inside `<Text>`; a bare string inside a `View` warns (and crashes on native). `Alert`, `Dialog`, `EmptyState` accept plain strings and wrap them.
- react-native-web cancels the browser's "Enter submits the form" whenever a text input has `onSubmitEditing`, so `TextField` only attaches it on native.
- `kind` on `TextField` (`email`, `password`, `newPassword`, `integer`, `decimal`, ...) sets keyboard, autofill and capitalisation in one place.
- Colours on the web are `var(--ol-...)` references, so a component can not compute with them in JavaScript.

## Sign-in and the session

- The access token (15 min) lives **only in memory**. The refresh token is an HttpOnly cookie the page cannot read. After a reload the app restores the session by asking the API to refresh.
- Refresh tokens are single use. `SessionManager` makes sure only one refresh runs at a time (in a tab, and across tabs through a Web Lock) and shares the result between tabs.
- A private page redirects to `/login?next=...`; `safeNext` only accepts same-site paths.

**Known limitation.** If a tab is reloaded or closed while its refresh request is in flight, the server has already rotated the token but the browser never stored the new cookie; the next refresh then looks like token reuse and signs the user out everywhere. This needs a short server-side grace window for a just-rotated token; it is not implemented.

## Running it

```bash
pnpm services:up && pnpm db:init && pnpm services:mail
pnpm --filter @orderloop/api dev        # :4000
pnpm --filter @orderloop/worker dev     # CSV imports
pnpm --filter @orderloop/web dev        # http://localhost:3000/signup
```

Set `MAIL_PROVIDER=smtp`, `SMTP_HOST=127.0.0.1`, `SMTP_PORT=1025` in `.env` to see the verification and reset emails in Mailpit (http://localhost:8025). Use `127.0.0.1`, not `localhost`.

## Tests

| What                                                                                                  | Where                                | Run                                     |
| ----------------------------------------------------------------------------------------------------- | ------------------------------------ | --------------------------------------- |
| Components (theme, variants, forms, links, dialogs, tables, toasts) in jsdom through react-native-web | `packages/ui/src/*.test.tsx`         | `pnpm test`                             |
| Session manager, error messages, money, variants, form state                                          | `packages/features/src/*.test.ts(x)` | `pnpm test`                             |
| Browser scenarios in real Chrome, with a WCAG A/AA scan (axe) of every screen                         | `apps/web/e2e`                       | `pnpm --filter @orderloop/web test:e2e` |

The browser tests need `pnpm services:up` and `pnpm services:mail`. Their setup uses the isolated `orderloop_test` database and Redis index 2, builds the web app into `apps/web/build/e2e`, starts the API (:4100), worker and web app (:3100), and follows the real links from emails delivered to Mailpit. Every test also fails if the browser console shows anything other than an expected 4xx response. Set `E2E_SKIP_BUILD=1` to reuse the last build and `E2E_VERBOSE=1` to see server logs.

The scenarios cover: sign up and email verification, sign in and out, wrong password, protected-page redirect and open-redirect refusal, password reset (once-only link), reloads and two tabs at once, sign-out across tabs, product creation and validation, stock receive/adjust/reserve and refusal of overdrawing, locations, categories, archive/restore, search, CSV import through the worker, an invited accountant seeing a read-only catalog, keyboard-only sign-in, and phone-width layout.

## Not built yet

- Mobile sign-in and catalog screens. The shared screens exist; the mobile app still needs a native session adapter (refresh token in secure storage, sent in the request body) and an expo-router `Navigation` adapter.
- Team management screens (invite, roles) and a tenant switcher.
- Translations (all text is English, in the screens).
- Reservations show a reference and quantity but not the variant, because the API's reservation record carries only the variant id.
