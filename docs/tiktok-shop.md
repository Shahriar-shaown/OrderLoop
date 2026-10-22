# TikTok Shop: a read-only order mirror that keeps stock honest

A seller connects a **TikTok Shop**. OrderLoop **reads** that shop's orders, lets a person map each TikTok SKU to an OrderLoop
variant, and then **reserves, releases and ships OrderLoop stock** as the TikTok orders move, so the stock count stays true while the
same goods sell on TikTok.

> **Status: implemented from third-party SDK source code, never run against TikTok.** There are no TikTok credentials: TikTok Shop is
> not available in Bangladesh and none can be obtained for a Bangladesh business. Everything in mock mode is exercised by automated
> tests. The live path (sign-in, tokens, webhooks, order reads) is covered by tests that use a **fake TikTok** which checks request
> signatures, tokens and single-use refresh tokens, so it proves OrderLoop's own behaviour, **not** that TikTok accepts these calls
> today. TikTok's own documentation (partner.tiktokshop.com) is rendered with JavaScript and could not be read: every detail below is
> marked **from SDK / third party, verify against partner.tiktokshop.com before going live**. Do not tell anyone this integration
> works with TikTok until the [activation checklist](#activation-checklist) has been completed with real credentials.

## The scope decision (and why)

OrderLoop's own orders, money, phone numbers and addresses are **Bangladesh and BDT only** (`formatBdt`, the `+8801...` phone rule,
the division / district address form). A TikTok order arrives in **the shop's own currency** (MYR, USD, GBP, ...) with **its own
country's address**. Forcing it into OrderLoop's `orders` table would either corrupt those rules or invent exchange rates. So:

- TikTok orders are **not** written into `orders`, and never reach finance, revenue, profit, COD or the dashboards.
- They live in their own tables (`tiktok_orders`, ...) in the shop's currency as **integer minor units** (`bigint`), **never converted
  and never summed with BDT**. Every order carries its `currency` and `currencyExponent` so a client formats it correctly.
- **No buyer personal data is stored at all**: no name, phone, email, address, message or buyer id. Only what stock sync and the order
  list need: TikTok's order id, status, timestamps, line items (SKU ids, seller SKU, product name, quantity, unit price), totals,
  currency, the shop's region and the fulfilment type. See [What is stored](#what-is-stored-and-what-deliberately-is-not).
- It is **read-only**: OrderLoop never changes anything at TikTok (no fulfilment or tracking push, no inventory push).

## Contents

1. [Facts, with sources](#verified-facts)
2. [What is NOT verified](#not-verified)
3. [Architecture and data flow](#architecture)
4. [What is stored, and what deliberately is not](#what-is-stored-and-what-deliberately-is-not)
5. [Stock rules](#stock-rules)
6. [SKU mapping](#sku-mapping)
7. [Token lifecycle](#token-lifecycle)
8. [Mock and live mode](#mock-and-live)
9. [Activation checklist](#activation-checklist)
10. [Sign-in flow and the begin step](#sign-in-flow)
11. [Webhooks and the catch-up check](#webhooks-and-the-catch-up-check)
12. [Connection health](#connection-health)
13. [Data handling and retention](#data-handling)
14. [Configuration](#configuration)
15. [UI contract](#ui-contract)
16. [Troubleshooting](#troubleshooting)
17. [Limitations and future work](#limitations)

## Verified facts

"Verified" here means **read in the source code of a TikTok Shop SDK**, not confirmed by TikTok. Read on **2026-10-22**.

Sources:

- EcomPHP/tiktokshop-php, `src/Auth.php`, `src/Client.php`, `src/Webhook.php`, `src/Resources/{Order,Authorization,Event}.php`
  (`gh api repos/EcomPHP/tiktokshop-php/contents/src/...`). The main reference.
- hsib19/tiktok-shop-sdk (TypeScript), `packages/sdk/src/{utils/signature.ts,modules/*,types/*}`: a second, independent SDK used to
  cross-check the signature, the paths and the response field names.
- Hookdeck, "Guide to TikTok Shop webhooks": <https://hookdeck.com/webhooks/platforms/guide-to-tiktok-shop-webhooks-features-and-best-practices.md>
  (the webhook signature header, retry ladder and acknowledgement rules).

| Topic                  | What the sources say                                                                                                                                                                                                                                                                                                                                                                |
| ---------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Hosts                  | Auth: `https://auth.tiktok-shops.com`. API: `https://open-api.tiktokglobalshop.com/`. Default API version `202309` (part of every path). Sandbox "no longer works" for 202309 and later: there is no sandbox. All three are configurable here (`TIKTOK_AUTH_HOST`, `TIKTOK_API_HOST`, `TIKTOK_API_VERSION`).                                                                        |
| Authorize URL          | `{auth host}/oauth/authorize?app_key=...&state=...`                                                                                                                                                                                                                                                                                                                                 |
| Token exchange         | `GET {auth host}/api/v2/token/get` with `app_key`, `app_secret`, `auth_code`, `grant_type=authorized_code`. Answer envelope `{ code, message, request_id, data }`; `code` 0 is success. `data` has `access_token`, `refresh_token`, `access_token_expire_in`, `refresh_token_expire_in`, `open_id`, `seller_name`.                                                                  |
| Token refresh          | `GET {auth host}/api/v2/token/refresh` with `app_key`, `app_secret`, `refresh_token`, `grant_type=refresh_token`.                                                                                                                                                                                                                                                                   |
| Authorised shops       | `GET /authorization/202309/shops` -> `data.shops[]` with `id`, `cipher`, `name`, `region`, `seller_type`, `code`. The `cipher` goes in every shop-level call as the `shop_cipher` query parameter.                                                                                                                                                                                  |
| Every API call carries | Query `app_key`, `timestamp` (seconds), `sign`, and `shop_cipher` for shop-level calls; header `x-tts-access-token`. The SDK removes `shop_cipher` for `/authorization/` and `/seller/` paths.                                                                                                                                                                                      |
| Request signature      | Take every query parameter except `sign`, `access_token` and `x-tts-access-token`; sort by key; concatenate `key` + `value` (arrays skipped); put the request **path** in front; append the **raw body** for requests that are not GET and not multipart; wrap the whole string with `app_secret` on both sides; HMAC-SHA256 with `app_secret` as the key; lowercase hex is `sign`. |
| Orders                 | Detail: `GET /order/202309/orders?ids=a,b`. Search: `POST /order/202309/orders/search` with query `page_size`, `page_token`, `sort_field`, `sort_order` and a JSON body (`order_status`, `create_time_ge`, `update_time_ge`, `update_time_lt`, ...). Search answers `orders[]`, `next_page_token`, `total_count`.                                                                   |
| Order fields used      | `id`, `status`, `create_time`, `update_time`, `is_on_hold_order`, `fulfillment_type`, `payment` (`currency`, `sub_total`, `shipping_fee`, `seller_discount`, `platform_discount`, `tax`, `total_amount`, amounts as **decimal strings in major units**), `line_items[]` (`id`, `sku_id`, `seller_sku`, `product_name`, `sale_price`). Nothing else is read.                         |
| Line items             | TikTok's `line_items` has **no quantity field** in the SDK types: each unit is its own entry. OrderLoop adds them up per `sku_id` (a `quantity` field, if one ever appears, is honoured).                                                                                                                                                                                           |
| Order statuses         | `UNPAID`, `ON_HOLD`, `AWAITING_SHIPMENT`, `PARTIALLY_SHIPPING`, `AWAITING_COLLECTION`, `IN_TRANSIT`, `DELIVERED`, `COMPLETED`, `CANCELLED`.                                                                                                                                                                                                                                         |
| Webhook subscription   | Partner Center (per app), or the Events API `PUT /event/202309/webhooks` with `{ address, event_type }` (also `GET` and `DELETE`). Event types seen: `ORDER_STATUS_CHANGE` (the one used), `PACKAGE_UPDATE`, `PRODUCT_STATUS_CHANGE`, `SELLER_DEAUTHORIZATION`, `UPCOMING_AUTHORIZATION_EXPIRATION`, `RECIPIENT_ADDRESS_UPDATE`, `RETURN_STATUS_CHANGE`, ...                        |
| Webhook body           | `type` (numeric, "unreliable to branch on"), `tts_notification_id` (the dedupe key), `shop_id`, `timestamp`, `data`. The SDK names the types: 1 order status, 2 reverse order, 3 recipient address, 4 package, 5 product status, 6 seller deauthorization, 7 upcoming authorization expiry, 12 return status.                                                                       |
| Webhook signature      | The `Authorization` header (no `Bearer`) holds the lowercase hex HMAC-SHA256 of `app_key + rawBody`, keyed with `app_secret` (SDK `Webhook::verify`, compared with `hash_equals`).                                                                                                                                                                                                  |
| Webhook delivery       | At least once. Answer **HTTP 200 with an empty body within 3 seconds**; 401 for a wrong signature. Retries after about 2 minutes, 30 minutes, 3 hours and 12 hours, then **stops**. The endpoint must be HTTPS on a domain (no raw IP, no custom port) with TLS 1.2 or later.                                                                                                       |
| App review             | Production access needs app review (privacy policy URL, a demo video of the OAuth flow, a description of the data handled); reported to take one to two weeks.                                                                                                                                                                                                                      |
| Markets                | TikTok Shop is live only in some markets (reports include the US, UK, several EU countries, Brazil, Mexico, Japan, Indonesia, Malaysia, Thailand, Vietnam, the Philippines, Singapore and a few more; the lists differ by source). A shop belongs to **one region**; cross-border and local sellers exist. **Not Bangladesh.**                                                      |

## Not verified

None of the following has been confirmed against TikTok's own documentation or a real account. Treat each as a to-do before going live.

1. **Everything in the table above**, as a whole: paths, parameter names, field names and the signature are as the two SDKs have them.
2. **Token lifetimes and the meaning of `*_expire_in`.** Sources disagree: an absolute Unix timestamp, or a number of seconds; an access
   token of one day or of ten. OrderLoop reads the field either way (a value after 2001 is a timestamp, a smaller one a duration) and
   renews early (see [Token lifecycle](#token-lifecycle)). Whether the **refresh token is single use** is also unknown; it is treated as
   if it were (both tokens are replaced together, atomically).
3. **Error codes.** Only HTTP status and message wording are used to classify failures, plus the token codes `105001`, `105002`,
   `105003`, which are themselves unverified. See `classifyTikTokError` in `packages/automation/src/tiktok/client.ts`.
4. **The webhook `data` object.** OrderLoop reads `order_id` (and, for a mock shop only, `order_status`, `update_time`,
   `is_on_hold_order`). For a live shop the notification is only a **pointer**: the order is fetched from TikTok and the status
   comes from there. The numeric `type` values are those in the SDK constants.
5. **Search response shape.** The SDKs disagree on whether `orders/search` returns whole orders or only ids. OrderLoop reads whole
   orders when `line_items` is present and fetches the rest by id. The `sort_field=update_time`, `sort_order=ASC` pair and the
   `update_time_ge` / `update_time_lt` body fields are as in the SDK types.
6. **Whether TikTok sends one line item per unit.** If it ever sends a quantity, it is honoured; if it lists a partially cancelled unit,
   that is not reflected (see [Limitations](#limitations)).
7. **`is_on_hold_order`.** Treated as "inside the buyer's cancellation window: no stock moves yet".
8. **The scopes the app needs** and their names: read orders, read shop / authorisation info. Choose them in Partner Center; the
   app must not ask for more than reading (see the [checklist](#activation-checklist)).
9. **Sign-in callback parameters.** The redirect is read as `?code=...&state=...`; TikTok's denial format is not documented in the
   sources, so a missing `code` is treated as a refusal (`access_denied`).
10. **Rate limits**, regional hosts and partner centres, the app types TikTok offers, whether the Events API is allowed for your app, and
    app review requirements.
11. **Auto-subscribing the webhook at connect time** (Events API `PUT`). It is attempted best-effort; if it fails, subscribe once in
    Partner Center.

## Architecture

```
TikTok Shop ──signed webhook──► POST /v1/webhooks/tiktok-shop (API)
                                  1 verify Authorization = HMAC(app_key + raw bytes), constant time   (401 otherwise)
                                  2 parse; one lookup: tiktok_connection_for(shop_id)  (the only cross-business read)
                                  3 INSERT event ON CONFLICT DO NOTHING (key: tts_notification_id)
                                  4 queue job  tiktok-event__<event id>  (never waits for Redis more than 1.5 s)
                                  5 answer 200, EMPTY body            (a sweeper queues events Redis missed)
                                                │
                                                ▼
                                  worker: processTikTokEvent
                                  live: fetch the order from TikTok  (the notification's status is NOT trusted)
                                  mock: the order rides on the event
                                  ONE transaction: claim event (row lock) ─► upsert tiktok_orders (never backwards, by TikTok's
                                  update_time) ─► link SKUs ─► stock reconciler ─► stock_state
                                                ▲
every 10 min: catch-up check per live connection ─ orders changed since last_synced_at (10 min overlap, <= 10 pages)
every 15 min: token renewal scan                   ─ one refresh per grant, advisory-locked
daily:        health check                          ─ shops still authorised, token still accepted
```

Shared code:

- `packages/domain/src/tiktok.ts`: the pure rules (status ranking, the monotonic guard, money parsing, token maths, the stock plan).
- `packages/automation/src/tiktok/`: the TikTok client (injected `fetch`), signatures, webhook parsing, ingestion, event processing,
  token renewal, catch-up, health, sweeper, retention, job names. Used by the API (mock mode, sign-in, manual sync) and the worker.
- `packages/catalog/src/tiktok.ts`: applies a snapshot and the stock plan **in a transaction with the existing stock functions**
  (`reserveStock`, `resolveReservation`): the only code that changes stock for a TikTok order. `packages/automation` may not depend
  on `catalog`, so the worker and the API hand it in as a `TikTokOrderSink`.
- `apps/api/src/tiktok/`: routes, sign-in, mock mode, orders and SKU links. `apps/worker/src/tiktok.ts`: the processors and schedules.

Queues: `tiktok-events` (one job per stored event, 5 tries with 10 s exponential back-off) and `tiktok-maintenance` (repeatable jobs
`sync`, `refresh`, `health` under fixed scheduler ids, so any number of workers still run one of each).

## What is stored, and what deliberately is not

Tables (migration `20261101100000_tiktok_shop`, all with forced row-level security, composite tenant keys, in `TENANT_TABLES`):

| Table                   | Holds                                                                                                                                                                                                                                                                                                      |
| ----------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `tiktok_connections`    | One per shop: TikTok's shop id (unique across businesses while connected), cipher, shop name, region, seller type, currency, status, the **sealed** access and refresh tokens (AES-GCM, bound to business and slot), expiries, grant id, scopes, last sync, last error (a code and a sentence, no tokens). |
| `tiktok_oauth_sessions` | The sign-in hand-over: hashed state, a sealed token pair until shops are chosen, the offered shops (id, name, region, seller type; no tokens, no cipher). Ten minutes, single use.                                                                                                                         |
| `tiktok_events`         | Webhook events: key, type (`order_status`, `package`, `deauthorization`, `other`), order id, timestamp, status (`received`, `processed`, `ignored`, `failed`), error word. Payload: ids and a status word only.                                                                                            |
| `tiktok_orders`         | The mirror: external order id, raw status, `on_hold`, TikTok's `update_time`, currency, exponent, subtotal, seller discount, platform discount, shipping, tax, total (all `bigint` minor units), fulfilment type, shop region, lines, `stock_state`, `attention`, `mock`.                                  |
| `tiktok_sku_links`      | TikTok SKU id -> OrderLoop variant (nullable), seller SKU, product name, `auto` or `manual`. Unique per (connection, SKU id).                                                                                                                                                                              |
| `tiktok_stock_holds`    | One row per order line that moved stock: variant, quantity, the reservation, state (`held`, `shipped`, `released`). Unique per (order, line): the exactly-once barrier.                                                                                                                                    |

**Never stored, anywhere**: buyer name, phone, email, address, postal code, buyer message, TikTok buyer id, seller note. The order
parser (`parseTikTokOrder`) reads a fixed list of fields and never touches `recipient_address`, `buyer_email`, `buyer_message`,
`user_id` or anything else; the webhook parser drops `data` after reading `order_id`. There is no column that could hold them, and a
test (`apps/api/test/tiktok-live.e2e.test.ts`) feeds orders full of synthetic buyer details and then searches **every text column of
every table of the business** for them, and checks the column names of the new tables. The `region` is the **shop's**, never taken
from the buyer's address. The stock ledger reason is `TikTok order <TikTok order id>` and nothing else.

## Stock rules

Pure rules (`planTikTokStock`, unit-tested table), applied transactionally by `reconcileTikTokOrder`. Reference type of the
reservations and ledger lines: `tiktok_order`; idempotency keys `tt-reserve|ship|release:<order>:<line>`.

| TikTok status                                                    | Stock effect                                                                                                                                        |
| ---------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| `UNPAID`, `ON_HOLD`, an order inside the buyer hold, unknown     | None. (A later status is acted on.)                                                                                                                 |
| `AWAITING_SHIPMENT`, `AWAITING_COLLECTION`, `PARTIALLY_SHIPPING` | **Reserve** every line that has no hold yet (once per line). `PARTIALLY_SHIPPING` reserves, it does not ship: TikTok does not say which lines left. |
| `IN_TRANSIT`, `DELIVERED`, `COMPLETED`                           | **Ship** (fulfil) every held line. A line never reserved (the order was first seen late) is reserved and shipped, once.                             |
| `CANCELLED` before shipping                                      | **Release** what is held.                                                                                                                           |
| `CANCELLED` after shipping                                       | **No automatic change.** The order gets `attention: cancelled_after_shipping` for a person (returns are out of scope).                              |

Guarantees:

- **Exactly once per line**: a line with a hold is never acted on again (the plan sees it); the order row is locked for the whole
  reconcile; the hold (unique per order line) and every ledger movement (unique idempotency key) are unique in the database. Webhook
  retries, duplicate deliveries, concurrent workers, replays and the catch-up check cannot move stock twice (tested with 12
  concurrent deliveries and 12 concurrent workers).
- **Never backwards**: TikTok's `update_time` decides, not arrival order. An older status arriving late changes nothing; an equal
  timestamp goes to the further-along status.
- **All-or-nothing per order**: if **any** line has no mapped variant the **whole order** waits in `stock_state: needs_mapping` and
  **nothing** moves (not even the mapped lines). If **any** variant has less available than the order needs, **nothing** is reserved
  (`stock_short`): stock is never oversold and never half-promised. This does not fail the job: it is recorded and visible. Shipping
  lines that already hold stock is always allowed.
- **Waiting orders are looked at again** when a person maps a SKU (at once) and every ten minutes by the catch-up check (and by
  `POST .../connections/:id/sync`), so stock that arrives later resolves a `stock_short` order. A mock shop is only looked at again by
  the manual sync and by mapping.
- Stock is taken from and returned to the **default location**, like OrderLoop's own orders. A line that holds stock keeps the
  variant it was held on even if the SKU link is changed or cleared later.
- Reservations of TikTok orders cannot be released or fulfilled by hand (`409`): only this code moves them.

`stock_state` values: `none`, `reserved`, `shipped`, `released`, `needs_mapping`, `stock_short`.

## SKU mapping

TikTok SKUs are mapped to OrderLoop variants through `tiktok_sku_links`.

- **Auto-link on first sight**: the TikTok `seller_sku` equals an OrderLoop variant SKU, case-insensitively and exactly, and exactly
  one active variant matches (SKUs are unique per business, so a match is never ambiguous). Nothing fuzzy.
- Otherwise the link stays unmapped and a person maps it: `PUT /v1/tiktok-sku-links/:id { variantId }` (audited
  `tiktok.sku_linked` / `tiktok.sku_unlinked`). A link a person set or cleared (`source: manual`) is never auto-linked again.
- Mapping triggers a reconcile of that connection's waiting orders in the same request (`reconciledOrders` in the answer).

## Token lifecycle

- The sign-in yields one access token and one refresh token for the seller; **every shop authorised in that sign-in shares them**
  (`grant_id`). Both are sealed (AES-GCM, key `COURIER_CREDENTIALS_KEY`, bound to the business and the slot) and never returned or logged.
- **Renewal**: a repeatable job scans every 15 minutes. A token is renewed when it is inside its window: **half its lifetime, at least
  10 minutes and at most 24 hours** before expiry (or when the expiry is unknown). One connection per grant is renewed, under a
  transaction-level advisory lock that is **tried, never waited for**, so two workers never refresh twice; the due check is repeated
  under the lock. The new pair (**both** tokens, because a refresh token may be single use) and the expiries are written for every
  shop of the grant in **one transaction**.
- **Inline renewal**: a call that finds the access token expired (or within a minute of it) renews it first; a call TikTok refuses
  with "token invalid" renews once and repeats once.
- **Failure**: the old tokens stay. A refused refresh token marks every shop of the grant `needs_reconnect` (audited once); a
  permission error marks `permission_error`; a rate limit or outage backs the next attempt off (15 minutes, doubling, at most 6 hours;
  `refresh_failures`, `next_refresh_at`). Nothing is logged but the outcome.
- **Disconnecting** deletes the sealed tokens and the cipher.
- Known risk: if TikTok accepts a refresh but the database commit then fails, a single-use refresh token is lost and the shop must
  be reconnected. The window is one transaction.

## Mock and live

`TIKTOK_MODE=mock` (the default outside production; **production must set it explicitly**) or `live`. Every response carries `mode`.

|                   | mock                                                                                                                                                            | live                                                            |
| ----------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------- |
| Shop              | `POST .../mock/connection`: a labelled shop (`mock: true`, `mock_` id, region `MY`, currency `MYR`), no sign-in, no token                                       | Sign in with TikTok, choose shops                               |
| Orders            | `POST .../mock/orders`, `.../mock/orders/:id/status` (cancel = `CANCELLED`): the same ingestion code as a webhook, processed at once                            | TikTok's webhooks, fetched from TikTok; plus the catch-up check |
| Signed webhooks   | Work when `TIKTOK_APP_KEY` and `TIKTOK_APP_SECRET` are set (tests, `pnpm tiktok:demo --url`); the new status in the notification is applied to the stored order | Verified, then only the order id is used                        |
| `oauth/*`, tokens | `409 tiktok_not_configured`                                                                                                                                     | Real                                                            |
| Mock endpoints    | **404 in production unless `TIKTOK_ALLOW_MOCK_IN_PRODUCTION=true`** (pilot demos only, never next to real stock), 404 in live mode                              | 404                                                             |

`pnpm tiktok:demo` (mock mode, local database only): mock shop, an `AWAITING_SHIPMENT` order that reserves stock, the same webhook
replayed three times (no second reservation), `IN_TRANSIT` (ships once), a cancelled order (released), an order with an unmapped SKU
that waits and then resolves when the SKU is mapped, and the ledger lines. `--url http://localhost:4000` also sends a **correctly
signed** webhook to a running API.

## Activation checklist

Nothing below has been done: no credentials exist for a Bangladesh business. Do it on **staging first**.

1. **Eligibility.** The seller's shop must be in a market where TikTok Shop operates; a Bangladesh-registered business has no such shop.
   OrderLoop's own orders stay BDT-only: this module is for a shop whose goods also sit in OrderLoop's stock.
2. **Partner Center account for the shop's region** (partner.tiktokshop.com or the regional partner centre: regional hosts differ, so
   `TIKTOK_AUTH_HOST` / `TIKTOK_API_HOST` may need changing).
3. **Create the app** and choose the app type TikTok offers for a seller-facing tool. Note the **app key** and **app secret**.
4. **Scopes**: read orders, and the shop / authorisation info needed to list authorised shops. Nothing that writes (no fulfilment, product,
   inventory or customer-service scopes).
5. **Redirect URL**: register exactly `{API_PUBLIC_URL}/v1/integrations/tiktok-shop/oauth/callback` (shown as `redirectUrl` in
   `GET /v1/integrations/tiktok-shop`).
6. **Webhook**: URL `{API_PUBLIC_URL}/v1/webhooks/tiktok-shop` (HTTPS on a domain, TLS 1.2 or later, no IP, no custom port), event
   `ORDER_STATUS_CHANGE`. Connecting a shop also tries to subscribe it through the Events API; if that fails (see the API log), subscribe
   once in Partner Center. `SELLER_DEAUTHORIZATION` is handled too if you subscribe it (the shop is marked `needs_reconnect`).
7. **Environment** for **both** the API and the worker: `TIKTOK_MODE=live`, `TIKTOK_APP_KEY`, `TIKTOK_APP_SECRET` (16+ characters),
   `API_PUBLIC_URL` (https), `COURIER_CREDENTIALS_KEY`, and `WEB_APP_URL`. Restart both.
8. **Test with an authorised shop** (a role holder on the app): connect it, confirm `lastSyncedAt` fills, place or move a test order
   and watch `GET /v1/tiktok-orders`, the stock and the ledger. Check the API log for the webhook subscription message.
9. **Verify every item in [Not verified](#not-verified)** against partner.tiktokshop.com while doing step 8: especially the token
   expiry fields, the webhook `data` shape, the order search response, error codes for expired tokens, and whether TikTok sends a
   quantity per line item.
10. **App review**: submit with the privacy policy URL (see [privacy-and-deletion.md](privacy-and-deletion.md)), a screen recording
    of the sign-in flow (start, TikTok's page, back to the shop list, connect) and a description of the data handled (what is stored
    and what is not, above). Allow one to two weeks (reported).
11. **Staging verification before live**: a week with real orders on staging: no stock drift (compare the ledger with TikTok), webhook
    failures none, token renewal logged, `needs_mapping` empty or explained.
12. **Go live**: then, and only then, update [release/dependencies-and-status.md](release/dependencies-and-status.md) to say so.

## Sign-in flow

Copied from Meta's, the same CSRF-hardened design:

1. `POST /v1/integrations/tiktok-shop/oauth/start` (`integrations:manage`) creates a pending hand-over (signed state: business, person,
   random nonce, 10 minutes) and returns `{ authorizeUrl }`: **not TikTok's URL** but a one-time link (60 seconds, stored only as a
   hash in Redis, redeemed with an atomic `GETDEL`) to the API's `oauth/begin`.
2. The web app navigates the browser (top level) to `authorizeUrl`. `GET .../oauth/begin?ticket=` redeems the ticket, sets an
   **HttpOnly, SameSite=Lax** cookie (Secure in production, scoped to `/v1/integrations/tiktok-shop/oauth`) holding an HMAC of the state's
   nonce, and redirects (302) to TikTok's authorize page.
3. TikTok redirects the browser to `GET .../oauth/callback?code=...&state=...`. The API checks the **state signature and expiry**, then
   the **cookie** (so a URL forwarded to someone else cannot be completed in their browser), then **claims the state** (single use) before
   touching the code, exchanges the code, lists the authorised shops, seals the token pair into the hand-over, and redirects to
   `{WEB_APP_URL}/settings/integrations/tiktok-shop?session=<uuid>`. The cookie is cleared whatever the outcome. A token is never in a URL.
   Errors come back as `?error=` with one of: `access_denied`, `invalid_state`, `tiktok_not_configured`, `tiktok_permission_denied`,
   `tiktok_token_invalid`, `tiktok_unavailable`, `rate_limited`.
4. `GET .../oauth/sessions/:id` lists the offered shops (`alreadyConnected` when another business, or this one, holds it).
   `POST .../connections { sessionId, shopIds[] }` seals the tokens per shop, subscribes the order webhook (best effort), runs the first
   read of the last 7 days, and answers `201 { connections, failures }` (a shop taken by another business is a per-shop `conflict`;
   when none can be connected the call fails). **One business per shop** is enforced by a partial unique index as well.
5. Reconnecting: `POST .../connections/:id/reconnect` starts the same flow for one connection; connecting then revives that connection
   (its orders and links stay), audited `integration.tiktok_reconnected`.

## Webhooks and the catch-up check

- `POST /v1/webhooks/tiktok-shop` is public, throttled generously, reads the **raw body**, and checks `Authorization` in constant time **before parsing**.
  Wrong, missing or malformed signature: **401**, nothing stored. Everything else: **200 with an empty body**, including an unknown shop
  (nothing kept: there is nowhere to keep it, it is counted), a disconnected shop (recorded as `ignored: connection_disconnected`),
  a package update (`ignored: recorded_only`), any other type (`ignored: unsupported_event`) and a body that is not JSON. The whole answer
  stays under TikTok's 3 seconds even when Redis is down: the event is stored first, and `sweepReceivedTikTokEvents` (every 30 s)
  queues what Redis missed.
- **Dedupe**: `tts_notification_id`; when absent, a deterministic hash of shop id, type, timestamp, order id and status. Unique per
  (business, connection, key), inserted `ON CONFLICT DO NOTHING`. The queue job id is `tiktok-event__<event id>` (BullMQ forbids `:`).
- **The retry ladder ends**: TikTok stops after about 12 hours, so a **catch-up check** runs per live connection every 10 minutes: it
  searches orders changed since `last_synced_at` (minus a 10 minute overlap), at most 10 pages of 50, oldest change first, backs off
  on rate limits (1 s, then 3 s, then gives up until the next run), and puts each order through the **same** upsert and reconcile as a
  webhook. `last_synced_at` advances to the start of the run only when everything was read; if cut short it advances only as far as it
  got (so a large backlog is read over several runs and nothing is skipped). `POST .../connections/:id/sync` runs it on demand.

## Connection health

A daily job checks every live connection: it lists the authorised shops with the saved token. A refused token marks `needs_reconnect`;
a refused permission, or a shop no longer in the list, marks `permission_error`; success marks `active` again. A rate limit or outage
changes nothing. The first change to each state is written to the audit trail (`integration.needs_attention`, ids and a code). There
is no in-app notification yet and no operator alert for it (see [release/known-limitations.md](release/known-limitations.md)).

## Data handling

- **Webhook events**: ids and a status word, kept 30 days (events still `received` stay).
- **Mirrored orders**: kept `TIKTOK_RETENTION_DAYS` (default 180, minimum 30) after their last change, only when in a final state
  (`COMPLETED`, `CANCELLED`, `DELIVERED`) **and** holding no live reservation; their lines and holds go with them. The reservations
  and ledger lines stay (they are OrderLoop's stock history).
- **Sign-in hand-overs** (they hold a sealed token pair): deleted a day after they expire, on success and on schedule/purge.
- **Disconnecting** deletes the sealed tokens and cipher; the mirror and any reserved stock stay as they are. Reserved stock of
  open orders stays reserved until the shop is reconnected (the catch-up check then reads what changed) or the orders are resolved.
- **Business deletion**: scheduling it disconnects every TikTok shop (tokens deleted) and drops sign-ins in progress; the purge after the
  grace period deletes all six tables with the business (`purge_tenant` was extended and the purge test covers them).
- **Customer erasure** needs no TikTok handling: there is no customer data in these tables. TikTok orders are not OrderLoop customers.
- Details: [privacy-and-deletion.md](privacy-and-deletion.md). Nothing here is a statement about any law.

## Configuration

| Variable                                                   | Default                                 | Notes                                                                                                        |
| ---------------------------------------------------------- | --------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| `TIKTOK_MODE`                                              | `mock` (production: **must be set**)    | `mock` or `live`. API and worker must agree.                                                                 |
| `TIKTOK_ALLOW_MOCK_IN_PRODUCTION`                          | `false`                                 | Pilot demos only: lets the mock endpoints exist in production.                                               |
| `TIKTOK_APP_KEY`                                           |                                         | Required for live. Also enables the signed webhook route in mock mode.                                       |
| `TIKTOK_APP_SECRET`                                        |                                         | 16+ characters; required for live. Signs requests, webhooks and the sign-in state. Never logged or returned. |
| `TIKTOK_AUTH_HOST`                                         | `https://auth.tiktok-shops.com`         | https only.                                                                                                  |
| `TIKTOK_API_HOST`                                          | `https://open-api.tiktokglobalshop.com` | https only.                                                                                                  |
| `TIKTOK_API_VERSION`                                       | `202309`                                | Six digits; part of every path.                                                                              |
| `TIKTOK_RETENTION_DAYS`                                    | `180`                                   | 30 to 3650.                                                                                                  |
| `API_PUBLIC_URL`, `WEB_APP_URL`, `COURIER_CREDENTIALS_KEY` |                                         | Live needs the first (https) and the last; the web address is where the sign-in returns to.                  |

Live mode without the four required values refuses to start and names each one.

## UI contract

For the screens that follow this change. Everything is in `packages/contracts/src/tiktok.ts`, `routes.ts` and the typed client
(`api.tiktokShop`, `api.tiktokOrders`, `api.tiktokSkuLinks`). Every response that has a `mode` says `mock` or `live`: **label mock data**
(`mock: true` on connections and orders) and say clearly on every screen that **amounts are in the shop's currency and are not BDT**.

**Money.** `totalMinor` etc. are integers in minor units of `currency`; divide by `10 ^ currencyExponent` (0 for JPY or VND, 2 for MYR, 3
for KWD) and show with that currency. **Never add them to BDT figures, never format them with the BDT formatter, never show a `BDT` or
`৳` sign.**

**Routes**

| Method and path                                                                     | Permission            | Contract                                                                                                                                                              |
| ----------------------------------------------------------------------------------- | --------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /v1/integrations/tiktok-shop`                                                  | `integrations:read`   | `TikTokOverview`: `mode`, `liveConfigured`, `webhookUrl`, `redirectUrl`, `connections[]`, `needsMappingOrders`, `stockShortOrders`, `attentionOrders`, `unmappedSkus` |
| `POST .../oauth/start`                                                              | `integrations:manage` | `TikTokOauthStartResult { mode, authorizeUrl }`; `409 tiktok_not_configured` in mock mode                                                                             |
| `GET .../oauth/begin`, `GET .../oauth/callback`                                     | public                | Browser redirects only; never call them with fetch                                                                                                                    |
| `GET .../oauth/sessions/:id`                                                        | `integrations:manage` | `TikTokOauthSession { id, expiresAt, shops[{ id, name, region, sellerType, alreadyConnected }], reconnectConnectionId }`; `400 tiktok_oauth_invalid`                  |
| `POST .../connections`                                                              | `integrations:manage` | body `{ sessionId, shopIds[] }` -> `201 ConnectTikTokShopsResult { connections[], failures[{ shopId, code, message }] }`                                              |
| `DELETE .../connections/:id`                                                        | `integrations:manage` | `TikTokConnection`                                                                                                                                                    |
| `POST .../connections/:id/reconnect`                                                | `integrations:manage` | `TikTokOauthStartResult`                                                                                                                                              |
| `POST .../connections/:id/sync`                                                     | `integrations:manage` | `TikTokSyncResult { mode, fetched, updated, reconciled, truncated }`; `409 tiktok_token_invalid` / `tiktok_permission_denied` when TikTok refuses                     |
| `POST .../mock/connection`, `.../mock/orders`, `.../mock/orders/:id/status`         | `integrations:manage` | **Mock mode only, 404 otherwise.** `TikTokMockResult { eventId, notificationId, duplicate, status, orderId, stockState }`                                             |
| `GET /v1/tiktok-orders?status=&stockState=&connectionId=&attention=&cursor=&limit=` | `orders:read`         | `TikTokOrderPage { mode, items: TikTokOrderSummary[], nextCursor, counts }` (counts per stock state, whole business)                                                  |
| `GET /v1/tiktok-orders/:id`                                                         | `orders:read`         | `TikTokOrder` (summary + money + `lines[]`)                                                                                                                           |
| `GET /v1/tiktok-sku-links?unmapped=&connectionId=&cursor=&limit=`                   | `inventory:read`      | `TikTokSkuLinkPage { items, nextCursor, unmappedCount }`                                                                                                              |
| `PUT /v1/tiktok-sku-links/:id`                                                      | `inventory:write`     | body `{ variantId: uuid or null }` -> `{ link, reconciledOrders }`; `400` when the variant is not this business's or is archived                                      |
| `POST /v1/webhooks/tiktok-shop`                                                     | public                | TikTok only                                                                                                                                                           |

**Connection status** (`TikTokConnection.status`): `active`, `needs_reconnect` (show "Reconnect"; `POST .../reconnect`), `permission_error`
(show "Reconnect and approve all permissions"), `disconnected` (show "Connect again"). `lastErrorCode` is one of `token_invalid`,
`permission_denied`, `deauthorized` (or null); `lastErrorMessage` is a sentence safe to show. `lastSyncedAt` is the last finished catch-up
check; `tokenExpiresAt` is informational (the worker renews it).

**Order status** (`TikTokOrder.status`, raw, upper-case): `UNPAID`, `ON_HOLD`, `AWAITING_SHIPMENT`, `PARTIALLY_SHIPPING`,
`AWAITING_COLLECTION`, `IN_TRANSIT`, `DELIVERED`, `COMPLETED`, `CANCELLED`; **tolerate any other string**. `onHold: true` means inside the buyer's
cancellation window (no stock moves yet).

**Stock state** (`stockState`) and what to show:

| Value           | Meaning                                                                        | Show                                                               |
| --------------- | ------------------------------------------------------------------------------ | ------------------------------------------------------------------ |
| `none`          | Nothing reserved (unpaid, on hold, cancelled before reserving, unknown status) | neutral                                                            |
| `reserved`      | Stock is held                                                                  | "Stock reserved"                                                   |
| `shipped`       | Stock left                                                                     | "Stock shipped"                                                    |
| `released`      | Cancelled before shipping; stock given back                                    | "Stock released"                                                   |
| `needs_mapping` | A line's TikTok SKU is not linked: **nothing moved for the whole order**       | warning; link to the SKU list (`unmapped=true`); count on `orders` |
| `stock_short`   | Not enough available stock for the whole order: nothing reserved               | warning; "Receive stock, then sync" (it retries by itself)         |

**`attention`**: `cancelled_after_shipping` (or null). Show a prominent flag: the order was cancelled after its stock shipped, stock was NOT
changed, a person decides (returns are out of scope).

**Order line** (`lines[]`): `key`, `externalSkuId`, `sellerSku`, `productName`, `quantity`, `unitPriceMinor`, `variant` (`{ id, sku,
productName, variantName }` or null), `mapped` (bool), `hold` (`held`, `shipped`, `released` or null), `skuLinkId`. A line with `mapped:
false` and `hold: null` is what blocks the order: offer the variant picker on it (`PUT /v1/tiktok-sku-links/:skuLinkId`).

**The unmapped-SKU flow**: list `GET /v1/tiktok-sku-links?unmapped=true` (each item has `waitingOrders`, the number of orders it blocks) ->
person picks a variant -> `PUT /v1/tiktok-sku-links/:id { variantId }` -> the answer's `reconciledOrders` says how many waiting orders were
looked at again; refetch the orders. Clearing (`variantId: null`) is allowed; it does not touch stock already reserved.

**Error codes** the screens should handle: `tiktok_not_configured` (409: live not set up, or live-only call in mock mode),
`tiktok_oauth_invalid` (400: sign-in expired or used, start again), `tiktok_permission_denied` (422), `tiktok_token_invalid` (409:
reconnect), `tiktok_unavailable` (502: try again), `rate_limited` (429), `conflict` (409: shop belongs to another business), `forbidden`,
`validation_failed`, `not_found`. The sign-in redirect's `?error=` values are listed in [Sign-in flow](#sign-in-flow).

**What to say**: this reads TikTok Shop and keeps stock honest; it never changes anything at TikTok; TikTok orders are in the shop's
currency, are not OrderLoop orders, are not in finance or revenue, and carry no customer details; this connection has not been tested
with TikTok yet (until the checklist is done, say so).

## Troubleshooting

| Symptom                                | Likely cause and what to do                                                                                                                                                                                                                                                                     |
| -------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Webhooks never arrive                  | Not subscribed (Partner Center, or the Events API call failed at connect: see the API log), URL not https / has a port / IP, TLS older than 1.2, or `TIKTOK_APP_KEY` / `TIKTOK_APP_SECRET` not set on the API (the route is then 404). The catch-up check still reads orders every ten minutes. |
| Webhooks answer 401 in TikTok's log    | The app key or secret differs from the app's, or something re-serialised the body before it reached the API (a proxy that rewrites JSON): the signature is over the exact bytes.                                                                                                                |
| An order is stuck in `needs_mapping`   | A SKU is not mapped: `GET /v1/tiktok-sku-links?unmapped=true`, map it. Auto-linking needs the TikTok seller SKU to equal an OrderLoop variant SKU.                                                                                                                                              |
| An order is stuck in `stock_short`     | Not enough available stock at the default location. Receive stock; the next check (or the sync button) reserves it.                                                                                                                                                                             |
| Connection `needs_reconnect`           | TikTok refused the token or the refresh token (revoked, expired, or the seller removed the app). Reconnect; orders changed meanwhile are read afterwards.                                                                                                                                       |
| `needs_reconnect` right after a deploy | `COURIER_CREDENTIALS_KEY` changed without keeping the old key in `COURIER_CREDENTIALS_OLD_KEYS`: sealed tokens cannot be opened. Reconnect, or restore the key.                                                                                                                                 |
| Stock looks wrong after a disconnect   | Reserved stock of open orders stays reserved while disconnected. Reconnect (the catch-up check reads what changed), or resolve the orders.                                                                                                                                                      |
| `last_synced_at` does not move         | Rate limited, an outage, or more than 500 changed orders (it then advances in steps). Check the worker log for `tiktok.sync_failed`.                                                                                                                                                            |
| Amounts look wrong                     | They are in the shop's currency in minor units: use `currencyExponent`. Never compare them with BDT.                                                                                                                                                                                            |

## Limitations

- **Read-only.** No fulfilment or tracking push to TikTok, no inventory push to TikTok (a shop's TikTok stock is not updated from OrderLoop).
- **No returns or refunds handling.** A cancellation after shipping is flagged, not reversed.
- **Partial cancellations of single units are not reflected**; `combined_listing_skus` bundles are treated as one SKU.
- **No finance integration, no BDT**: no revenue, profit, COD or settlement for TikTok orders, by design.
- **Markets**: only where TikTok Shop operates (not Bangladesh). A shop has one region.
- **Webhooks are not reliable on their own**: the retry ladder ends after about 12 hours, so the ten-minute catch-up check is mandatory,
  and a connection that needs reconnecting stops being read until it is reconnected.
- **One default location** is used for stock (like OrderLoop's own orders).
- **No in-app notification or operator alert** when a connection needs reconnecting (the status and audit trail show it).
- **Single API replica**: the webhook throttle is in memory per instance, like Meta's.
- Everything in [Not verified](#not-verified).
