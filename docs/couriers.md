# Couriers

Orders are booked with a delivery company from the order page, and the company's updates move the order forward. Three
couriers sit behind one provider-independent interface (`packages/courier-sdk`): **Pathao**, **Steadfast**, and a
**simulated** courier for development, demos and tests.

> **Read this first: how much of this has been checked against the real services.** Pathao's and Steadfast's own merchant API
> reference pages could not be read when this was built (they are rendered by JavaScript behind a sign-in). Nothing here was
> run against a real Pathao or Steadfast account. The code follows the sources in the table below and is tested against
> **mocked HTTP responses** shaped like those sources. Before going live, do the checks in
> [First contact with a real courier](#first-contact-with-a-real-courier).

## Sources, and how far each one can be trusted

| Fact                                                                               | Source                                                                                | Status                                                         |
| ---------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- | -------------------------------------------------------------- |
| Pathao hosts, token login, stores, city/zone/area lists, create order, its fields  | Pathao's own open-source WooCommerce plugin (`pathao-eng/courier-woocommerce-plugin`) | Written by Pathao; not the reference page                      |
| Pathao webhook (events, signature header, handshake, integration header)           | The same plugin                                                                       | Written by Pathao; not the reference page                      |
| Pathao price estimate (`merchant/price-plan`) and order info (`orders/{id}/info`)  | A community SDK (`Sifat07/pathao-merchant-sdk`)                                       | **Unverified**: community only                                 |
| Pathao password-grant login (`issue-token`)                                        | The same community SDK                                                                | **Unverified**; only used if you enter a username and password |
| Pathao rate limit (~60 requests a minute)                                          | Community reports                                                                     | **Unverified**; we stay at 60                                  |
| Steadfast statuses, create-order fields, webhook (Bearer token, payloads)          | Steadfast's own Laravel package (`steadfast-it/SteadFast-Courier-Laravel-Package`)    | Written by Steadfast; not the reference page                   |
| Steadfast header names (`Api-Key`, `Secret-Key`), status/balance endpoints, limits | A community SDK (`Sifat07/steadfast-merchant-sdk`), cross-checked with the package    | Mostly confirmed by two sources; **verify**                    |
| Steadfast webhook `Idempotency-Key` and retry timings                              | Community SDK                                                                         | **Unverified**; used only if the header is present             |

Where a source was missing the feature is **not offered**, not guessed:

- **Pathao has no documented cancel endpoint** and **no way to look a booking up by our own reference**. We offer no Cancel
  button for Pathao (you cancel in Pathao's panel, then record it here) and treat an unconfirmed Pathao booking as needing a
  person (see [Booking safely](#booking-safely)).
- **Steadfast has no documented estimate endpoint and no cancel endpoint.** "Get estimate" is not offered, and cancelling is
  done in Steadfast's panel and recorded here.
- Steadfast's tracking page address is never invented: a link is shown only if Steadfast sends one.

## What it can do

| Capability                         | Pathao                        | Steadfast                          | Simulated                |
| ---------------------------------- | ----------------------------- | ---------------------------------- | ------------------------ |
| Connection settings and test       | yes (lists your stores)       | yes (a harmless balance call)      | yes                      |
| Places lists (city, zone, area)    | yes                           | no                                 | simulated list           |
| Fee estimate / serviceability      | yes (**unverified** endpoint) | no                                 | simulated                |
| Book a parcel with COD             | yes                           | yes                                | yes (simulated)          |
| Track (ask the courier)            | yes (**unverified** endpoint) | yes                                | returns what it was told |
| Status updates pushed to us        | yes (webhook)                 | yes (webhook)                      | no (buttons instead)     |
| Cancel through the API             | no                            | no                                 | yes                      |
| Failed delivery and return info    | yes (statuses)                | statuses: hold, cancelled, partial | yes                      |
| Look up a booking by our reference | no                            | yes (`status_by_invoice`)          | configurable             |

Money is whole taka for COD: both couriers take whole numbers, so a cash amount with paisa is **refused before anything is
sent** rather than rounded.

## Credential setup

### Where credentials live

Secrets are entered once on **Settings → Couriers**, travel to the API over HTTPS, are encrypted with **AES-256-GCM** and
stored only as ciphertext. They are **write-only**: no API response, page or app ever contains them, and the saved audit
entry records only _that_ they changed. The encryption also binds each secret to its business and courier, so a value copied
to another row will not decrypt. They are decrypted in memory only to call the courier, and the logger redacts them.

The server needs a key:

```bash
openssl rand -base64 32      # put the result in .env as COURIER_CREDENTIALS_KEY
```

Without it, Pathao and Steadfast cannot be connected (the settings page says so); the simulated courier still works. **Back
the key up.** If it is lost, every saved credential becomes unreadable and sellers must enter them again.

To rotate: set a new `COURIER_CREDENTIALS_KEY` and a new `COURIER_CREDENTIALS_KEY_ID` (for example `k2`), and move the old key
to `COURIER_CREDENTIALS_OLD_KEYS=k1:<old key>`. Old values keep working; each is re-encrypted with the new key the next time
it is saved. Remove the old key only when every business has re-saved (or you accept re-entry).

| Variable                       | Meaning                                                                                        |
| ------------------------------ | ---------------------------------------------------------------------------------------------- |
| `COURIER_CREDENTIALS_KEY`      | 32 random bytes, base64. Required to connect real couriers.                                    |
| `COURIER_CREDENTIALS_KEY_ID`   | Name of that key (default `k1`), stored with each secret.                                      |
| `COURIER_CREDENTIALS_OLD_KEYS` | Retired keys, `id:base64,id:base64`.                                                           |
| `COURIER_MOCK_ENABLED`         | The simulated courier. On except in production, where it must be turned on on purpose.         |
| `API_PUBLIC_URL`               | The public address of the API, used to show the webhook address (must be `https` in practice). |

Only the API holds the key. The web and mobile apps cannot import the courier package (`pnpm check:boundaries` fails the
build if they try) and never see a secret.

### Pathao

1. You need a Pathao Courier merchant account. API access (a client ID and secret) is issued by Pathao; **it is not
   self-service in every case, and approval may be needed. Ask Pathao** (their merchant API portal / support).
2. A **store** must exist in your Pathao account before you can book. Pathao's plugin notes that new stores need Pathao's
   approval (about an hour). Use **Test Pathao** here: it lists your store IDs, and you enter yours in the settings.
3. In **Settings → Couriers → Pathao** choose **Sandbox** (Pathao's test environment) first, enter the client ID and client
   secret, your store ID, and save. Press **Test Pathao**.
4. Webhooks (optional but recommended): choose a long random secret (16+ characters), enter it in OrderLoop as the webhook
   secret and save, then give Pathao the **webhook address** shown on the page, with the same secret. Pathao sends a
   "webhook_integration" handshake; OrderLoop answers it only when the secret matches. The address must be a public `https`
   URL (use a tunnel such as `ngrok` when developing). Pathao also states what it expects: a `2xx` reply within 10 seconds,
   which we send.
5. Switch to **Live** only after a real test booking in the sandbox.

### Steadfast

1. You need a Steadfast Courier merchant account. The API key and secret key are in your Steadfast panel. If you cannot find
   them, **ask Steadfast whether API access must be enabled for your account**.
2. **Steadfast documents no sandbox.** Every booking is real and may be collected on. Test with one real parcel you are
   prepared to cancel in their panel.
3. In **Settings → Couriers → Steadfast** enter the API key and secret key and save, then press **Test Steadfast**. (Repeated
   wrong keys can lock an account for a while, so we never retry a rejected key.)
4. Webhooks (optional): choose a long random token (16+ characters), save it in OrderLoop, then in Steadfast's panel set the
   callback URL to the **webhook address** shown and the "Auth token" to the same value. Steadfast then calls us with
   `Authorization: Bearer <token>`; anything else gets `401`.

### Simulated courier

**Settings → Couriers → Simulated courier → Turn on.** No credentials. It can be told to misbehave (refuse, time out, be
down) so the unhappy paths can be rehearsed.

## Telling simulated from real

A simulated booking can never be mistaken for a real one:

- every simulated shipment carries `simulated: true` and the environment `simulated` (a database constraint ties
  `simulated`, `environment = 'simulated'` and `provider = 'mock'` together, so a real courier's parcel can never be marked
  simulated and the reverse);
- its parcel id starts `SIM-`, its tracking address is `https://simulated.invalid/...` (a name that can never resolve), and
  its events say "Simulated update. No courier sent this.";
- the screens show **SIMULATED · not a real parcel** wherever it appears, and the booking button says "Book simulated
  parcel";
- the simulate buttons exist only for simulated shipments (the API refuses them for real ones).

## Booking safely

The dangerous failure is booking one order twice, so a parcel is **claimed before the courier is called**, and the claim is
backed by the database:

1. In one transaction, with the order row locked, we check: the order is **Ready to ship**; there is **no live shipment** for
   it; this `idempotencyKey` was not used (a repeat returns the original shipment, and the same key with a different request
   is refused with `idempotency_conflict`). We then record the shipment as `booking`. A unique index (one live shipment per
   order) is the last word if two requests race.
2. Only then is the courier called, outside any transaction, with our reference (`OL-<order number>`; a second attempt after a
   failure gets `OL-<n>-2`, so couriers that refuse repeated references never confuse attempts).
3. The result is recorded: `booked`, `booking_failed` (the courier said no, or never received it: nothing exists), or
   `booking_uncertain` (we do not know).

`booking_uncertain` is what a timeout or a server error produces: the courier may have created the parcel and the answer
was lost. A booking is **never retried automatically after an unknown outcome** (only after a `429` "slow down", where
nothing was created):

- **Steadfast** can be asked by our reference: we look it up. Found: it is `booked` (no second booking). Not found: it is
  `booking_failed`, safe to retry (Steadfast also refuses a repeated invoice).
- **Pathao** and the simulated courier (by default) cannot be asked. The shipment stays `booking_uncertain`; **booking is
  blocked and so is cancelling the order**, until a person opens the courier's panel, looks for the reference, and says what
  they saw (**Settle this booking**). A later webhook for that parcel also settles it, as proof it exists.
- A booking claimed but never settled (the server died mid-call) is treated as unconfirmed after two minutes.

In the screens the same key is reused when a request fails without an answer, so pressing **Book** again retries the same
booking and cannot make a second parcel; once the server has answered, the next booking is a new one.

## What the courier's news does to the order

| Courier says                           | Shipment becomes                  | Order becomes                                                                    |
| -------------------------------------- | --------------------------------- | -------------------------------------------------------------------------------- |
| booked / pending / pickup requested    | `booked`                          | unchanged (still _Ready to ship_, stock still reserved)                          |
| picked up                              | `picked_up`                       | _Shipped_ (the reserved units leave stock)                                       |
| in transit / at hub / out for delivery | `in_transit` / `out_for_delivery` | _In transit_                                                                     |
| delivered                              | `delivered`                       | _Delivered_                                                                      |
| delivery failed                        | `delivery_failed`                 | _Delivery failed_                                                                |
| return started                         | `returning`                       | _Return requested_ (through _Delivery failed_ if needed)                         |
| returned to merchant                   | `returned`                        | **unchanged**: a person marks it returned and says which items can be sold again |
| partial delivery                       | `partial_delivered`               | **unchanged**: a person checks and records what came back                        |
| on hold / pickup failed                | `on_hold`                         | unchanged                                                                        |
| a status we do not recognise           | unchanged                         | unchanged. The courier's words are shown and kept                                |

Courier news can only carry a handed-over order forward along moves the order's own state machine allows. It can never
confirm, cancel, restock or reopen an order, and it never changes stock except through the normal "shipped" step. Those
moves appear in the order's history with the reason "Courier update: <the courier's own words>" and no person's name.

The courier's **original status text is always kept** (`providerStatus` on the shipment and on every event) beside our mapped
status. An update that arrives late or out of order is recorded as _not applied_ with the reason, never silently dropped. A
repeated delivery of the same event (same key) is recognised and changes nothing.

While a live shipment exists the order's address and phone cannot be changed (`409 shipment_conflict`: the courier keeps the
copy it was booked with); cancel the shipment, change the address, book again. Saving an unchanged address, or notes, is fine.

An order cannot be cancelled while a live shipment exists. Cancel the shipment first (Simulated courier: the Cancel button;
Pathao and Steadfast: cancel in their panel, then **Mark cancelled at the courier**), then cancel the order.

Moving the order for a courier's news is all-or-nothing: if a later step is refused, the earlier ones (stock leaving the
shelf, history) are rolled back to a savepoint and the shipment's event says "The order was not changed: <why>". Cancelling
through the courier's API keeps the shipment row locked from the check to the update, so two cancels, or a webhook arriving
meanwhile, take turns (the webhook waits for the courier's answer, which has its own timeout). A booking's weight is checked
against the courier's range before a shipment row exists (`400`, naming the range: Pathao 0.5 to 10 kg; Steadfast and the
simulated courier 0.1 to 50 kg), using `capabilities.weightKg` from the courier package (always present on a courier's capabilities).
A courier's refusal is `422 courier_rejected` (credentials, booking or cancellation) and something it cannot do through its API is
`422 courier_unsupported`, wherever it happens, cancel included; an unreachable courier is `502 courier_unavailable`. Every order status change also
re-checks the cash discrepancies of that order's settlement lines.

## Cash to collect with paisa

Both real couriers and the simulated one take whole taka only, and a confirmed order cannot be edited, so an order whose cash to
collect (total minus advance) has paisa can never be booked. The order carries `codHasPaisa` so a screen can warn before booking,
and booking is refused up front with `422 courier_unsupported` and what to do (cancel the order and enter it again with amounts
that make the cash a whole number of taka); no shipment row is created. The order rules are unchanged.

## Booking replies that arrive late

If a person settles an unconfirmed booking as "not booked" (or "cancelled at the courier") and the courier's reply then says a
parcel was created, the shipment stays as the person left it, but a shipment event (not applied) and an audit entry
`shipment.orphan_booking` (`kind: orphan_booking`, ids only) record the parcel so it can be cancelled in the courier's panel.

## Webhooks and how they are verified

`POST /v1/webhooks/couriers/:provider/:tenantId/:connectionId`, public (no sign-in), authenticated by the courier's own method:

- **Pathao**: the `X-PATHAO-SIGNATURE` header carries the webhook secret you chose (it is _not_ an HMAC; this is how Pathao's
  own plugin checks it). We compare in constant time. Replies carry `X-Pathao-Merchant-Webhook-Integration-Secret` (Pathao's
  published constant, which identifies the integration and authenticates nothing); the handshake event answers `202`.
- **Steadfast**: `Authorization: Bearer <the token you chose>`; wrong or missing is `401`; malformed payloads are `400`.

The tenant and connection are in the address so the right business's secret can be found without a session. A wrong tenant, an
unknown connection, a missing secret and a wrong secret all answer the same `401`. The body is not looked at until the secret
has been checked. An event for a parcel we never booked is acknowledged (`200`) so the courier stops resending; an event that
arrives while we are still booking is answered `503` so the courier sends it again shortly.

## Timeouts, retries, rate limits and errors

- Every courier call has a timeout (no hanging requests) and never follows redirects.
- Reads (tracking, lookups, lists) retry on timeouts, connection resets, `429` and `5xx`, up to three attempts with a short
  backoff, honouring `Retry-After` (capped at 30 seconds).
- A booking is retried only when nothing could have been created (`429`, or a refused connection), never after a timeout or a
  `5xx` (see Booking safely).
- Each courier connection is paced by a client-side limiter below the documented or reported limits.
- Authentication failures are reported plainly ("did not accept the saved credentials") and not retried. A Pathao token that
  turns out stale is replaced once.
- Courier error text is not trusted as safe to echo beyond a refusal reason; credentials never appear in an error.
- Courier base URLs are fixed in code (Pathao: production and sandbox; Steadfast: its two hosts). A seller cannot make the
  server call an address of their choosing.

## API

| Request                                                                                                                                                                             | Permission                       |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------- |
| `GET /v1/couriers`, `GET /v1/orders/:id/shipments`, `GET /v1/shipments/:id`                                                                                                         | `couriers:read` (every role)     |
| `PATCH/DELETE /v1/couriers/:provider`, `POST /v1/couriers/:provider/test`                                                                                                           | `couriers:manage` (owner, admin) |
| `GET /v1/couriers/:provider/locations`, `POST /v1/orders/:id/shipping-quote`, `POST /v1/orders/:id/shipments`, `POST /v1/shipments/:id/refresh`, `/cancel`, `/resolve`, `/simulate` | `orders:write`                   |
| `POST /v1/webhooks/couriers/:provider/:tenantId/:connectionId`                                                                                                                      | public; courier's own proof      |

`/resolve` as _not booked_ or _cancelled at the courier_ also needs `couriers:manage`: those let the order be booked again, so a
wrong call can send the courier two parcels. _Booked_ stays with `orders:write`.

`POST /v1/orders/:id/shipments` needs an `idempotencyKey`. Booking attempts are records: a refused or unconfirmed booking
returns `201` with the shipment and its `status` and `failureReason`.

## Tests

- `packages/courier-sdk` (106 tests): HTTP behaviour (timeouts, retries, `Retry-After`, never repeating a booking), status
  mapping and transition rules (property-style), webhook verification and parsing, and each adapter against **mocked HTTP**
  (`fakeNetwork`): login flows, token reuse and re-login, exact request bodies, refusal of whole-taka violations, errors never
  containing secrets.
- `apps/api/test/couriers.e2e.test.ts` (35 tests, real database, no real network): the checkpoint (book with the simulated
  courier, follow it to delivery, retry safely), concurrent duplicate bookings, uncertain bookings, cancel rules, secret
  handling (encrypted at rest, never returned or logged), roles, tenant isolation, and both couriers' booking, refresh and
  webhook flows (wrong secrets, replays, out-of-order, unknown statuses).
- `credential-vault.test.ts`: round trip, tampering, wrong business, key rotation.
- `apps/web/e2e/couriers.spec.ts`: the same checkpoint driven only through the screens, including a lost response.

## First contact with a real courier

Do these once, in this order, and fix the code against what the courier actually returns:

1. **Pathao sandbox**: save credentials, **Test Pathao** (checks login and store listing), load the city/zone lists, book one
   order, then **Check status now**. This is the first run of the `orders/{id}/info` and (if used) `price-plan` calls, which
   are community-sourced; if either answers differently, adjust `packages/courier-sdk/src/pathao.ts` and its tests.
2. **Pathao webhooks**: configure the webhook; confirm the handshake succeeds and a status change reaches the order.
3. **Steadfast**: test, book one parcel you can cancel, **Check status now**, then a webhook delivery.
4. Confirm the header names and rate limits still match Steadfast's reference, and Pathao's reference (obtain it from the
   portal while signed in).

## Not built

COD settlement and courier fee reconciliation (next phase); bulk booking; Steadfast return requests and balance display;
Pathao on-demand pricing options beyond delivery type; label printing; a background poller for providers without webhooks
(use **Check status now**); courier selection rules. Editing an order's address after booking is refused for the same reason: cancel the shipment and rebook.
