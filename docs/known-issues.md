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
