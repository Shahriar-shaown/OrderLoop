# Known issues and follow-ups

Found by a full code review (October 2026) and deliberately not changed yet, with the reason. Everything else the review found
was fixed. Each item names where to look.

## Needs a product or security decision

- **Profit can double-count courier charges.** `CostKind` offers `delivery_charge`, `return_charge` and `courier_deduction` as
  manual costs, and the same charges are also summed from imported courier statements (`packages/domain/src/settlements.ts`,
  `apps/api/src/finance/finance.service.ts`). A seller who records a charge by hand and imports the statement is charged twice.
  Options: remove those three kinds from manual costs, or exclude them from profit whenever statements cover the period.
- **The dashboard's profit is gross; the finance summary's is net.** Both use one definition of revenue and of the delivered set
  (`apps/api/src/finance/revenue.ts`), but the dashboard stops at revenue minus cost of goods, while the finance summary also
  subtracts courier charges and recorded costs. They are labelled differently on screen; the figures differ on purpose.
- **Register still answers "email already exists" (409).** An account-enumeration signal that forgot-password does not have. A
  uniform answer is impossible while registering signs the new person in on the spot: the new case returns a session, the
  existing case cannot (that would hand over the account), and a decoy session would fail on first use and so reveal the same
  fact. What is done instead: the owner of the address is emailed "you already have an account" (at most three an hour per
  address), the work done before answering is the same, and register is rate limited like login. The real fix is a sign-up that
  returns no session until the email is confirmed (`202` for every address), which changes the web and mobile sign-up flow.
- **Grace window for refresh tokens (10 s).** Inside it, presenting the previous token again (a lost response, then a retry)
  gets a fresh token instead of ending the session, as long as the token issued the first time was not used. Someone who stole
  a token and uses it within 10 s of the owner's refresh gets a session too; after that the usual reuse detection applies.
  `REFRESH_REUSE_GRACE_SECONDS` (0 turns it off).
- **A tenant switch starts a new session** (and the old one keeps its tenant), so another tab's token is not moved. In the
  browser the refresh cookie is shared by every tab, so without help a tab's _next refresh_ after someone else's switch would land
  in the newest tenant. Clients now send `expectedTenantId` with a refresh and get `409 tenant_changed` instead (nothing rotates);
  a client that sends nothing, or a native app, behaves as before. Sessions left behind by switches expire with the first one.
- **Cancelling a shipment holds the shipment row lock across the courier's HTTP call.** This is deliberate: two cancels, or a
  webhook arriving meanwhile, take their turn, and the courier is never asked twice. It also means the transaction (60 s limit)
  stays open for as long as the courier answers, bounded by the adapter's timeout. Fine for the simulated courier. A real adapter
  with a slow API should either keep its timeout well under the transaction limit or move to a "cancelling" status written before
  the call, so the lock is not held while waiting (`apps/api/src/couriers/shipments.service.ts`, `cancel`).

## From the correctness review (October 2026)

Fixed in the same pass: partial returns, shared payout ids, audit before/after, lock order and retry on deadlock, discrepancy
and Meta-draft races, orphan courier bookings, manual `delivered`/`returned` (`orders:close`), paisa COD pre-check,
`pnpm inventory:verify`. What stays, and why:

- **One stock location fills orders.** Confirming reserves at the default location only, while the stock screens, the low-stock
  list and the Meta draft view sum every location. When the default is short but another location holds the units, confirm now
  fails naming where they are and which location is the default. There are no transfers: for the pilot run with one location
  (see `docs/inventory.md`).
- **Partial returns and partial deliveries are not revenue splits.** A return lists the lines and quantities that came back;
  stock follows that. The order is still `returned` (no revenue), so units the customer kept are in neither revenue nor cost
  of goods. The finance summary says so in its caveats when a period has such returns. A courier `partial_delivered` never moves
  the order by itself: a person records what happened (delivered, or returned with the quantities that came back).
- **Statement keys changed.** A line's duplicate key now includes the parcel and kind even when the file has a transaction id.
  A statement file imported before this change is still recognised by its file hash, but a different file that overlaps it on
  lines with a transaction id will not match those older keys, so check the overlap by hand once.
- **Sums are 64-bit already.** Prisma's `_sum` over `Int` columns did not overflow with two 20,000,000.00 costs or statement lines
  (a regression test pins it), so those aggregates were left alone.
- **Cancelling a shipment keeps its transaction open over the courier call** only matters for the simulated courier today (see
  above); a real adapter must keep its timeout under the 60 s transaction limit.
- **Dashboard "sales delivered" is not revenue.** The dashboard's delivered count and amount follow the delivered set for the
  period (`revenue.ts`); revenue is goods plus delivery billed for the same set, and the finance summary's "sales" are all
  non-cancelled orders created in the period. Same orders, different questions: read the labels.
- **Low stock is defined twice.** The inventory list flags a variant per location row; the summary and the low-stock report use
  available stock over all locations against the reorder point. They agree with one location.
- **An archived location can still hold damaged stock.** Only on-hand and reserved block archiving; damaged units stay in the
  ledger and in `stock_levels`, and `inventory:verify` still counts them.
- **Replaying a stock request with the same idempotency key returns the current level**, not the level at the time of the first
  call.
- **Webhook order moves.** An unexpected (non-API) error while carrying an order forward no longer aborts the courier's webhook:
  the shipment keeps the news, the order is left as it was, the event says so and the error is logged. Deadlocks are retried.
- **Deadlock retry re-runs the transaction body** (up to 3 attempts, `Database.withContext`), so bodies must work through `tx`
  only. Today's callers do (queue adds use a job id, so a repeat is harmless).

## Needs more design

- **Pathao COD fee**: the unit of `cod_percentage` is unverified (see `docs/couriers.md`); the estimate says so.
- **Query cache keys carry no tenant id**; the cache is cleared whenever the person or business changes, which is what makes
  that safe today.
- **Styles keep `'unsafe-inline'`** in the Content-Security-Policy because react-native-web writes its style sheet at run time.
  Scripts are nonce-protected (`apps/web/proxy.ts`).

## Not verified

- **Docked keyboard on Android.** On API 35+ apps are edge-to-edge, so `softwareKeyboardLayoutMode: resize` has no effect.
  Screens now add the keyboard's height as bottom padding themselves (`useKeyboardInset`), but the emulator used here showed
  Gboard's floating keyboard, which never covers a field, so this is untested with a docked keyboard. Test on a device.
- **iOS and Android release builds, physical devices, tablets, VoiceOver and TalkBack.**
- **Email links opening the app** needs a domain, the `.well-known` files and `APP_WEB_HOST` (see `docs/mobile.md`).

## From the security review (October 2026)

Fixed in code: the cubic-time phone extraction, the Meta sign-in CSRF, the mock Meta endpoints and default mode in production,
`TRUST_PROXY`, the settlement import body limit, non-https courier tracking links, SMTP STARTTLS, https `WEB_ORIGINS`, push tokens
in request logs, secrets in worker error lines, `/health/ready` cost, and the same-tenant guard on product categories and
suppliers. What is **documented rather than changed**:

- **No RLS on `users`, `sessions`, `refresh_tokens`, `user_tokens`.** They are reached before a tenant is known, so they rely on
  `Database.global` discipline (typed to those four models, lookups keyed by unique identity or a token hash). A forgotten `where`
  would not be stopped by the database. Mitigations and review advice: [database.md](database.md#tables).
- **Per-IP request limits are in memory, per API instance**; the lockouts and per-business limits are in Redis. Use a Redis-backed
  throttler store before running more than one replica ([api.md](api.md#rate-limiting-and-lockout)).
- **`GET /openapi.json` is public by default.** It holds no secrets but maps every route. `OPENAPI_PUBLIC=false` hides it;
  recommended in production ([api.md](api.md#openapi-in-production)).
- **Forwarded Meta `begin` link.** The sign-in is bound to the browser that opens the one-time link, so an attacker who gets a
  victim to open the _begin_ link within 60 seconds and approve Meta's dialog still wins; forwarding Meta's own URL no longer works
  ([meta.md](meta.md#sign-in-flow-and-why-it-has-a-begin-step)).
- **Meta live signatures and payloads are unverified against real traffic (M4).** Run the staging checklist in
  [meta.md](meta.md#activation-checklist) (item 12) before `META_MODE=live`.
- **Mobile configuration** (Android `allowBackup`, an `http://` `EXPO_PUBLIC_API_URL` guard) is the mobile app's concern; see
  [mobile.md](mobile.md).
- **Phone numbers beyond the first 500 characters of a message** are not read by the Meta extractor (the price of bounded work).
- **A tracking link that is not https is dropped**, not repaired: a courier that only returns `http://` links shows no link.

### Dependency audit (`pnpm audit --prod --audit-level=high`, October 2026)

Four findings, all reached only through the mobile app's build tooling (Expo CLI, Metro), none in the API, worker or web runtime:

| Severity | Package                        | Advisory            | Reached through                                                  | Patched   |
| -------- | ------------------------------ | ------------------- | ---------------------------------------------------------------- | --------- |
| high     | `node-forge` <=1.4.0           | GHSA-86w9-cpqp-85rv | `expo > @expo/cli > @expo/code-signing-certificates`             | none yet  |
| high     | `braces` <=3.0.3               | GHSA-vfj7-8cjw-p6xm | `react-native > ... > metro > metro-file-map > micromatch`       | none yet  |
| moderate | `uuid` <11.1.1                 | GHSA-w5hq-g745-h8pq | `expo > @expo/cli > @expo/config > @expo/config-plugins > xcode` | >= 11.1.1 |
| moderate | `decode-uri-component` <=0.4.2 | GHSA-vcc3-ghjq-m6fr | `expo-router > query-string`                                     | >= 0.5.0  |

They run on a developer's or CI machine while bundling, on trusted input. They are not fixable here until Expo / React Native
move their dependencies (or a pnpm `overrides` entry is tested against a mobile build). Consequence for CI: the weekly
`audit.yml` run (high and above) will be red until the two high ones are patched; on pull requests it is informational only.
