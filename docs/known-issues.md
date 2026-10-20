# Known issues and follow-ups

Found by a full code review (October 2026) and deliberately not changed yet, with the reason. Everything else the review found
was fixed. Each item names where to look.

## Needs a product or security decision

- **Profit can double-count courier charges.** `CostKind` offers `delivery_charge`, `return_charge` and `courier_deduction` as
  manual costs, and the same charges are also summed from imported courier statements (`packages/domain/src/settlements.ts`,
  `apps/api/src/finance/finance.service.ts`). A seller who records a charge by hand and imports the statement is charged twice.
  Options: remove those three kinds from manual costs, or exclude them from profit whenever statements cover the period.
- **Two definitions of "profit".** The dashboard's gross profit ignores order-level discounts, delivery and courier costs; the
  finance summary includes them (`packages/contracts/src/dashboard.ts`, `finance.service.ts`). Both should come from one domain
  function.
- **Refresh-token reuse has no grace window.** Presenting an already-rotated token signs the user out everywhere
  (`apps/api/src/auth/session.service.ts`). On a phone, a lost response followed by a retry does exactly that. A short grace
  window for the immediately previous token is the usual answer; it is a security trade-off, so it is not done silently.
- **A tenant switch is shared by every tab and device** (`auth.service.ts` rewrites the session's active tenant), so a second tab
  keeps its old token but its next refresh returns the new tenant. Needs a session per tenant.
- **Register answers "email already exists"** (an account-enumeration signal) while forgot-password answers uniformly.

## Needs more design

- **Order stock effects inside a shipment webhook** catch an error inside the open transaction and carry on, so earlier steps can
  stay applied while the order does not move (`shipments.service.ts` `syncOrder`). Needs savepoints or pre-validation.
- **Cancelling a shipment** calls the courier without a lock; two people cancelling, or a webhook arriving meanwhile, can leave
  the local row and the courier disagreeing.
- **Editing the address of an order that has a booked parcel** is allowed and is not sent to the courier.
- **Order status changes do not re-check COD discrepancies**; "recheck" does.
- **Pathao COD fee**: the unit of `cod_percentage` is unverified (see `docs/couriers.md`); the estimate says so.
- **Booking weight**: the API accepts 0.1–50 kg; Pathao accepts 0.5–10 kg, so a booking outside that fails after the shipment row
  exists. Validate per provider before the row is created.
- **Content-Security-Policy keeps `'unsafe-inline'` for scripts** (Next's inline bootstrap scripts). A per-request nonce through
  Next's proxy convention removes it.
- **Query cache keys carry no tenant id**; the cache is cleared whenever the person or business changes, which is what makes
  that safe today.
- **An import left `PENDING`** if the API dies between committing the job and queueing it (no sweeper in the worker).
- **`listBatches` and `outstandingIn`** do several queries per row; fine for hundreds, slow for tens of thousands.

## Not verified

- **Docked keyboard on Android.** On API 35+ apps are edge-to-edge, so `softwareKeyboardLayoutMode: resize` has no effect and
  the keyboard can cover a focused field. The emulator used here showed Gboard's floating keyboard, which never covers the
  field. Test on a device; `react-native-keyboard-controller` is the usual fix.
- **iOS and Android release builds, physical devices, tablets, VoiceOver and TalkBack.**
- **Email links opening the app** needs a domain, the `.well-known` files and `APP_WEB_HOST` (see `docs/mobile.md`).
