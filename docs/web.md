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

To add a component: put it in the matching folder of `packages/ui/src` (`inputs`, `overlays`, `data`, `layout`, `navigation`, `feedback`, `theme`), give it variants rather than one-off styles, export it from `index.ts`, and add a test next to it. To restyle the product, change `theme/tokens.ts`.

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

## Automation and notifications

The backend is in [automation.md](automation.md); the screens are shared with the phone (`packages/features`).

| Screen                                | Route                        | Who                                                                                          |
| ------------------------------------- | ---------------------------- | -------------------------------------------------------------------------------------------- |
| Notifications (bell in the header)    | `/notifications`             | everyone: their own list, cursor-paged                                                       |
| Notification preferences              | `/notifications/preferences` | everyone: kind x in-app / push / email; SMS and WhatsApp consent when the server offers them |
| Automation (rules, run now, problems) | `/automation`                | `automation:read` to look, `automation:manage` to change, run and retry                      |

- The bell (`NotificationBell`) asks `GET /v1/notifications/unread-count` every 60 s while the tab is in front and again when it regains focus; marking read, "Mark all read" and a manual run refresh it.
- Tapping a notification marks it read and opens its screen (`notificationTarget` in `lib/notifications.ts`): low stock -> `/products?tab=low`; one order -> that order, several -> `/orders` (`?status=pending_confirmation` for the reminder); COD -> `/cod`; daily report -> `/dashboard`, weekly -> `/analytics`.
- Notification titles and texts are written by the server in English. The Bangla catalogue `i18n/bn.automation.ts` translates them by pattern; a low-stock list is taken apart in `lib/notificationText.ts` because it names products. A test builds every notification with the domain builders and checks nothing is left in English except product names and SKUs.
- Each rule's form is described once (`CONFIG_FIELDS` in `lib/automation.ts`) and checked against the contract's limits by a test; `fromDraft` also runs the contract's `parseRuleConfig`.
- Push is mobile only: the web runtime has no `push`, so registration, the permission prompt and the sign-out clean-up do nothing.
- Browser scenarios: `apps/web/e2e/automation.spec.ts` (set up low stock, run now, bell and list, open it, run again for no second alert, turn in-app off, an accountant has no rules).

## Facebook and Instagram messages (Meta)

The backend is in [meta.md](meta.md); the screens are shared with the phone (`packages/features/src/screens/meta`). **Receive-only**: there is no reply UI. Everything that is simulated says so.

| Screen                                       | Route                         | Who                                                                                                     |
| -------------------------------------------- | ----------------------------- | ------------------------------------------------------------------------------------------------------- |
| Integrations (accounts, connect, mock tools) | `/settings/integrations/meta` | `integrations:read` to look, `integrations:manage` to connect, reconnect, disconnect and use mock tools |
| Social orders (inbox of drafts)              | `/social-orders`              | `orders:read`; a count of drafts needing review sits beside it in the menu (polled every 60 s)          |
| Review a draft                               | `/social-orders/[id]`         | `orders:read` to look; `orders:write` to edit, confirm or dismiss                                       |

- **Mock notice.** "Mock integration: not connected to Meta" (`MockNotice`) shows on every screen whenever the overview says `mode: 'mock'` or a connection or draft has `mock: true`; connections and drafts also carry a "Mock" badge. In mock mode "Connect Facebook & Instagram" is disabled with the reason. The test tool sends a Bangla order to a mock account; its message id is derived from the account, sender and text (`mockMessageId`), so the same text again is the same message and creates nothing.
- **Sign-in with Meta** (live): `POST oauth/start`, then the browser goes to `authorizeUrl`. Meta returns to the same page with `?session=` (choose Pages: `PageSelection`, per-Page failures listed) or `?error=<code>` (each code has a plain message, see `OAUTH_ERRORS`). On the phone the screen says "Connect from the web app" and offers status, disconnect and the mock tools only.
- **Review** reuses the order form: `OrderForm` takes a `draft`, starts from its fields, and its Confirm calls `POST /v1/social-drafts/:id/confirm` with exactly the normal order payload and the form's one idempotency key (kept on retry). Low-confidence fields (below `CHECK_THIS_CONFIDENCE` = 0.7, from `@orderloop/domain`) say "Check this" until edited, thana and postal code included (prefilled from the draft's `area` and `postalCode`; "Save draft" sends `area`, and `postalCode` only when it is exactly four digits); items the extractor could not match show "Pick the product"; prices always come from the catalogue; possible duplicates list links and need "This is a different order" ticked before Confirm. "Save draft" sends only what changed. Closed drafts and people without `orders:write` get a read-only view. The list masks phone numbers (`017••••5678`), shows the start of the first message under it (`snippet`, the customer's own words, never translated) and, for a confirmed draft, "Order #123" linking to the order (the review page's banner also says it).
- Browser scenarios: `apps/web/e2e/meta.spec.ts` (mock banner, add account, Bangla message to order, replay creates nothing, second message joins the open draft, pick a product, dismiss, accountant read-only, accessibility and phone width). The e2e stack sets `META_MODE=mock`.

## Orders: returns, closing, couriers

- **Returns.** Moving an order to _returned_ shows every line with a quantity stepper (default: what was sent, 0 = not returned) and a condition (resaleable or damaged), then a plain summary ("Returning 1 of 2 Red / M; 0 of 1 Blue / L"). The API only restocks the lines it is given, so the payload (`returnPlan` in `lib/returns.ts`) holds one entry per line with a quantity above 0, `quantity` only when partial, and is left out when everything came back resaleable. A server error on `returnedItems.N.quantity` is shown beside the line that entry belongs to. Marking a return with nothing back is refused: cancel instead.
- **`orders:close`** (owner, admin, manager) is needed to move an order to _delivered_ or _returned_ by hand. Without it those buttons are not offered (order page, Next banner, bulk bar) and the page says "Only an owner, admin or manager can mark an order delivered or returned by hand." A `forbidden` on one row of a bulk change is explained in the bulk result list. Staff still do the moves that are theirs (confirm, ready, shipped, in transit).
- **Whole-taka cash.** Couriers take whole taka only (the server refuses a booking otherwise, simulated courier included). When `codHasPaisa` is true the booking form says the order cannot be booked and what to do (cancel and enter it again with whole-taka amounts) and disables Book; the order form summary and the order page (before the order is ready to ship) give the same advice as a soft hint when a courier is turned on. The `422 courier_unsupported` for it is worded by `messageFor` and translated.
- **Partly delivered parcels** (`partial_delivered`): the Next banner tells a person to mark the order returned with only the units that came back. Finance caveats (partly returned orders, no courier shipment) are printed as the API sends them and have Bangla patterns; statement imports list the API's `warnings` under the result ("Worth a look"), not only in a toast.

## Creating things safely, and offline

- Every create form uses `useIdempotencyKey`: one key per attempt, kept across retries, so a timeout or a double press never creates twice (orders, products, variants, suppliers, addresses, workspaces, invitations, rules, imports, courier bookings, drafts).
- Changes are never queued while offline: the guard refuses them at once with "You are offline. Nothing was sent." Reads stay on screen and refetch on reconnect. See [mobile.md](mobile.md#sessions-offline-and-expiry).

## Sign-in and the session

- The access token (15 min) lives **only in memory**. The refresh token is an HttpOnly cookie the page cannot read. After a reload the app restores the session by asking the API to refresh.
- Refresh tokens are single use. `SessionManager` makes sure only one refresh runs at a time (in a tab, and across tabs through a Web Lock) and shares the result between tabs.
- A private page redirects to `/login?next=...`; `safeNext` only accepts same-site paths.

- A tab reloaded or closed while its refresh is in flight no longer ends the session everywhere: the API accepts the previous token again for a short grace window (see [known-issues.md](known-issues.md)). A refresh sends `expectedTenantId`, so a tab does not follow another tab's business switch (`409 tenant_changed` makes it ask again instead).
- Registration can be closed on a server (`403 registration_closed`): the sign-up screen shows a clear alert with the next step and a link to sign-in.

## Deleting data

- **Customer detail:** _Erase personal data_ (owners and admins; `customers:erase`) with a plain explanation, a typed `ERASE` and an optional reason. An
  erased customer shows a notice and loses Edit, Create order and the address buttons. **Customers** has _Export customers CSV_.
- **Your account** (`/account`, from the account menu; mobile: More > Your account): who you are and _Delete my account_ (password asked again, the word
  `DELETE`, the blocking businesses listed if the API refuses).
- **Business settings > Delete this business** (owners only): the exports, a typed business name and the password. While a business is scheduled,
  `AppShell` (web) and the signed-in layout (mobile) replace the whole business with one screen (`TenantDeletedScreen`): the date, **Cancel deletion**
  for an owner, other businesses to switch to, and Sign out. It reads `GET /v1/tenant/deletion-status`.
- `/data-deletion` is a **public static page** (no sign-in) for people who cannot use the app, and is Meta's "Data deletion instructions URL"
  ([meta.md](meta.md)). Set `NEXT_PUBLIC_PRIVACY_CONTACT` to the operator's real address; until then it shows a clearly fake one.
- All three dialogs are one component, `DangerDialog` (typed confirmation, password, optional reason; a wrong password sits on the password box).
  `withTokenRetry` does not refresh and retry a `401 invalid_credentials`, so a wrong password never signs anyone out or counts twice.
  What each removes, keeps and cannot reach: [privacy-and-deletion.md](privacy-and-deletion.md).

## Running it

```bash
pnpm services:up && pnpm db:init && pnpm services:mail
pnpm --filter @orderloop/api dev        # :4000
pnpm --filter @orderloop/worker dev     # CSV imports
pnpm --filter @orderloop/web dev        # http://localhost:3000/signup
```

Set `MAIL_PROVIDER=smtp`, `SMTP_HOST=127.0.0.1`, `SMTP_PORT=1025` in `.env` to see the verification and reset emails in Mailpit (http://localhost:8025). Use `127.0.0.1`, not `localhost`.

## Tests

| What                                                                                                                 | Where                                   | Run                                     |
| -------------------------------------------------------------------------------------------------------------------- | --------------------------------------- | --------------------------------------- |
| Components (theme, variants, forms, links, dialogs, tables, toasts) in jsdom through react-native-web                | `packages/ui/src/**/*.test.tsx`         | `pnpm test`                             |
| Session manager, error messages, money, variants, form state, automation and notification screens, push registration | `packages/features/src/**/*.test.ts(x)` | `pnpm test`                             |
| Browser scenarios in real Chrome, with a WCAG A/AA scan (axe) of every screen                                        | `apps/web/e2e`                          | `pnpm --filter @orderloop/web test:e2e` |

The browser tests need `pnpm services:up` and `pnpm services:mail`. Their setup uses the isolated `orderloop_test` database and Redis index 2, builds the web app into `apps/web/build/e2e`, starts the API (:4100), worker and web app (:3100), and follows the real links from emails delivered to Mailpit. Every test also fails if the browser console shows anything other than an expected 4xx response. Set `E2E_SKIP_BUILD=1` to reuse the last build and `E2E_VERBOSE=1` to see server logs.

The scenarios cover: sign up and email verification, sign in and out, wrong password, protected-page redirect and open-redirect refusal, password reset (once-only link), reloads and two tabs at once, sign-out across tabs, product creation and validation, stock receive/adjust/reserve and refusal of overdrawing, locations, categories, archive/restore, search, CSV import through the worker, an invited accountant seeing a read-only catalog, suppliers with size and colour variants, damaged stock and write-offs, returns, an import that is checked before it is applied, CSV downloads, the dashboard's figures checked against seeded orders, a whole seller's day from sign-up to a delivered order with no database edits, the team page (invite, role change, removal), taking, confirming, cancelling and importing orders with the stock and totals checked, bulk actions, customers and addresses, editing business settings, creating and switching businesses without data leaking between them, read-only settings for non-admins, keyboard-only sign-in, and phone-width layout.

## Known limitations

- Reservations show a reference and quantity but not the variant, because the API's reservation record carries only the variant id.
- Signing in with Meta needs a browser: the phone app shows account status and the mock tools, and sends people to the web app to connect.
- Push notifications are phone-only; the web has the in-app list and bell.
- Explanatory sentences that the API writes (finance caveats, import warnings, courier messages) are translated by pattern where a pattern exists and stay English otherwise; a few sentences with inline bold text also stay English.
