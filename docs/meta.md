# Meta: Facebook Page Messenger and Instagram DMs as draft orders

Customers write to a seller's Facebook Page or Instagram business account. OrderLoop **receives** those messages through Meta's
webhooks, finds an order in them if there is one (phone number, address, items), and puts it in a review list as a **draft**. A
person checks the draft against the messages, corrects it, and confirms it. Only then does an order exist.

> **Status: implemented against Meta's documentation, not tested with authorised credentials.** Everything in mock mode is
> exercised by automated tests. The live path (sign-in, Page subscription, real webhooks, token checks) is covered by tests that
> use a fake Graph API, so it proves OrderLoop's own behaviour, not that Meta accepts these calls today. Before relying on it,
> run the [activation checklist](#activation-checklist) with accounts that have a role on your Meta app, and treat every item
> marked **verify before relying** as unproven.

What it never does: create an order by itself, send or reply to anyone, scrape, ask for a social password, read anything
Meta does not deliver to us, or download media.

## Contents

1. [Facts, with sources](#verified-facts)
2. [What is NOT verified](#not-verified)
3. [Architecture and data flow](#architecture)
4. [Permissions and why each is asked](#permission-scopes)
5. [Mock and live mode](#mock-and-live)
6. [Activation checklist](#activation-checklist)
   6b. [Sign-in flow and the begin step](#sign-in-flow-and-why-it-has-a-begin-step)
7. [Webhooks](#webhooks)
8. [Extraction](#extraction)
9. [Drafts and confirming](#drafts)
10. [Connection health](#connection-health)
11. [Data handling and retention](#data-handling)
12. [Limits](#limits)
13. [Configuration](#configuration)
14. [UI contract](#ui-contract)
15. [Troubleshooting](#troubleshooting)
16. [Known limitations and future work](#known-limitations)

## Verified facts

Pages re-opened on **2026-10-21** while building this. Only what those pages said is listed as verified.

| Fact                                                                                                                                                                                                                                                                                                                                                                                                             | Source                                                                                           |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| Webhook handshake: Meta sends `GET` with `hub.mode=subscribe`, `hub.verify_token`, `hub.challenge`; answer with the challenge when the token matches, else 403.                                                                                                                                                                                                                                                  | https://developers.facebook.com/docs/messenger-platform/webhooks                                 |
| Signature: header `X-Hub-Signature-256` = `sha256=` + HMAC-SHA256 of the payload with the App Secret. The page says the payload is hashed in an **escaped-unicode** form: non-ASCII as `\uXXXX`, lowercase hex ("äöå" -> `äöå`), and that hashing the decoded bytes gives a different signature. Validation is called optional but strongly recommended.                                                         | same                                                                                             |
| Page message payload: `object: "page"`, `entry[].id` = Page id, `entry[].messaging[]` with `sender.id` (PSID), `recipient.id`, `timestamp`, `message.mid`, `message.text`, `message.attachments[]` (types `image`, `audio`, `video`, `file`, `reel`, `ig_reel`).                                                                                                                                                 | same                                                                                             |
| Answer 200 within 5 seconds. If delivery fails Meta retries immediately a few more times (so deduplicate). Failing 15 minutes raises an alert; failing for 1 hour sends a "Webhooks Disabled" alert and **unsubscribes the app** from that Page / Instagram account until resubscribed. Order is not guaranteed during failures: use the `timestamp`.                                                            | same                                                                                             |
| Subscribe a Page: `POST /{page-id}/subscribed_apps?subscribed_fields=messages` with a Page token of a person who can perform the `MODERATE` task, needing `pages_messaging` and `pages_manage_metadata`. `subscribed_fields` includes `messages`, `messaging_postbacks`, `message_echoes`, `message_edits`, `message_reactions`, `message_reads`, `message_deliveries` and others. `GET` on the edge lists them. | same                                                                                             |
| Instagram messaging needs an Instagram **professional** account linked to a Facebook Page, and a person with the `MODERATE` task on that Page. Login: Facebook Login for Business, or Business Login for Instagram.                                                                                                                                                                                              | https://developers.facebook.com/documentation/business-messaging/instagram-messaging/get-started |
| Scopes for the user token: `instagram_basic`, `instagram_manage_messages`, `pages_manage_metadata`. The Page token must include `instagram_manage_messages`.                                                                                                                                                                                                                                                     | same                                                                                             |
| Tokens: a Page token derived from a **long-lived** user token has no expiration date; from a short-lived one it is valid for 1 hour.                                                                                                                                                                                                                                                                             | same                                                                                             |
| The Instagram account must enable **Allow Access to Messages**: Instagram settings > Messages and story replies > Message controls > Connected tools.                                                                                                                                                                                                                                                            | same                                                                                             |
| Apps used only for businesses you own or manage need **Standard Access** (no App Review). A **Tech Provider** serving multiple businesses needs **App Review** for **Advanced Access**. A submission needs: a 1024x1024 app icon, a privacy policy URL, an app category, a business email, step-by-step test instructions, a screencast per permission, and at least one successful API call per permission.     | https://developers.facebook.com/documentation/instagram-platform/app-review                      |

## Not verified

Taken from the project brief (not re-read on the date above) or inferred. **Verify before relying.**

- **Business Verification** for a Tech Provider: the App Review page does not mention it. It is probably needed for Advanced
  Access to these permissions; confirm in the dashboard's own prompts.
- Instagram-Login user tokens are long-lived for 60 days and refreshed with `GET /refresh_access_token?grant_type=ig_refresh_token`
  (token at least 24 hours old and unexpired). **Not used here**: this integration uses the Facebook Login Page-token flow, whose
  Page tokens do not expire, so no refresh job exists. If you switch to Instagram Login, you must add one.
- The **Deauthorize** and **Data Deletion Request** callbacks (`signed_request` = `base64url(signature).base64url(payload)`,
  HMAC-SHA256 with the app secret, answer `{url, confirmation_code}`) and that production apps must provide them: from the brief.
- **Which form the signature is computed over** in practice (raw bytes or `\uXXXX`-escaped). The docs say escaped; OrderLoop
  accepts either, in constant time. Other JSON escapes Meta might apply (for example `/`) are not handled: if real signatures fail
  for payloads with such characters, this is the place to look.
- **How Instagram webhook subscription works with Facebook Login.** The Instagram page does not include the steps. OrderLoop
  subscribes the **Page** (`messages`, `messaging_postbacks`) and also needs the Instagram `messages` webhook field enabled in
  the app dashboard. Whether the Page subscription is enough for Instagram events, or `instagram` needs its own subscription, is
  unproven.
- **The Facebook Login for Business dialog.** The dialog is built with `client_id`, `redirect_uri`, `state`, `response_type=code` and
  `scope`. Facebook Login for Business normally uses a login **configuration** (`config_id`) that holds the permissions; set
  `META_LOGIN_CONFIG_ID` to use it. Which of the two your app type needs is unproven.
- **Graph error codes**: 190 (token), 10 / 200 / 299 (permission), 4 / 17 / 32 / 613 (rate limit), 100 (bad parameter) are the
  mapping from the brief. The "Allow Access to Messages is off" error is **not known**: it is detected only by wording
  (`access to messages` in the message), which is a guess.
- `debug_token`'s `scopes` for a Page token (used by the daily check) and that the check's missing-scope rule never gives a false
  alarm.
- The current supported **Graph API version**. `META_GRAPH_VERSION` is deliberately required in live mode with no default; check
  Meta's changelog and pin a version that is currently supported.
- The 24-hour messaging window and the Human Agent tag: neither is described on the pages above. They only matter for **replying**,
  which this milestone does not do.

## Architecture

```
 customer                Meta                          OrderLoop API                        Postgres                     worker
    |  message to Page    |                                 |                                  |                           |
    |-------------------->|  POST /v1/webhooks/meta         |                                  |                           |
    |                     |  X-Hub-Signature-256            |                                  |                           |
    |                     |-------------------------------->| 1 verify signature (raw bytes,   |                           |
    |                     |                                 |   constant time) -> else 401     |                           |
    |                     |                                 | 2 parse; look up the account     |                           |
    |                     |                                 |   meta_connection_for() ---------> (the ONLY cross-business read)
    |                     |                                 | 3 in that business's context:    |                           |
    |                     |                                 |   INSERT social_events           |                           |
    |                     |                                 |   ON CONFLICT DO NOTHING ------->| unique (tenant, connection, mid)
    |                     |                                 | 4 queue job social-event__<id> --+-----------------> Redis (1.5 s cap, else swept)
    |                     |<--------------------------------| 200 (well inside 5 s)            |                           |
    |                     |                                 |                                  |   job: processSocialEvent |
    |                     |                                 |                                  |<--------------------------|
    |                     |                                 |                                  | lock conversation, extract|
    |                     |                                 |                                  | social_drafts (1 open per |
    |                     |                                 |                                  | connection + customer)    |
    |  person reviews:  GET /v1/social-drafts/:id, PATCH, POST .../confirm  (the normal order path, same transaction) |
```

- **Persist first, queue second.** The stored event is the source of truth. If Redis is down or slow the webhook still answers
  200; a sweeper in the worker (every 30 s) queues events that stayed `received` for more than a minute. Job ids are
  `social-event__<event id>` (BullMQ forbids `:`), so queueing twice is a no-op.
- **Idempotent at every level.** `(tenant_id, connection_id, external_event_id)` is unique (the message id), so Meta's immediate
  retries and any replay create nothing new; the processor locks the event row and reads its status under the lock; one
  conversation is processed by one worker at a time (advisory lock), and a customer's unprocessed messages are processed together,
  so the result does not depend on which job runs first.
- **Tenant boundaries.** `meta_connection_for(provider, external_id)` is a `SECURITY DEFINER` function returning only
  `(connection id, tenant id, status)` for a connected account. Everything after runs inside that business's row-level-security
  context. Other cross-business reads are likewise narrow functions: `stale_received_social_events`, `live_social_connections`,
  `meta_deletion_targets`, `purge_social_data`. The owner role has owner-only policies for them; `app_user` stays confined.
- **Code layout.** `packages/automation/src/meta/` (signature, Graph client, webhook parsing, ingestion, processing, health,
  retention, sweeper) is shared by the API and the worker (it already holds the queue conventions and `fetch`-based providers);
  `packages/domain/src/social-extract.ts` is the pure extractor; `apps/api/src/meta/` is the HTTP surface; `apps/worker/src/meta.ts`
  wires the queues. Tokens are sealed with `SecretBox` (the courier credential key and format).
- **Echoes, edits, postbacks.** An echo (our own business's reply) is recorded as an `ignored` event with **no text**. An edit
  (`message_edit`) is recorded and ignored: extraction is not re-run, because the original message is what the customer sent when
  they ordered. A postback is recorded and ignored. Deliveries, reads and reactions are not stored at all.
- **Out-of-order events** are ordered by their own `timestamp` when appended to a draft.

## Permission scopes

Only these five are requested at sign-in:

| Scope                       | Why                                                                                                      |
| --------------------------- | -------------------------------------------------------------------------------------------------------- |
| `pages_show_list`           | To list the Pages the person manages, so they can choose which to connect.                               |
| `pages_messaging`           | To receive the Page's messages (webhook subscription) and for the Page token to be allowed to read them. |
| `pages_manage_metadata`     | To subscribe the app to the Page's webhooks (`/subscribed_apps`).                                        |
| `instagram_basic`           | To read the Instagram professional account linked to the Page (its id and username).                     |
| `instagram_manage_messages` | To receive that Instagram account's direct messages.                                                     |

No scope for posts, comments, ads, insights or profile data is asked for. No **sending** permission is used: replies are done by
the seller in Meta's own inbox.

## Mock and live

`META_MODE` is `mock` (default outside production) or `live`. **In production it must be set explicitly** (the API and worker refuse
to start without it), and the mock endpoints answer **404 in production even with `META_MODE=mock`** unless
`META_ALLOW_MOCK_IN_PRODUCTION=true` is also set. That flag exists for pilot demos only: a production server with mock endpoints
lets any `integrations:manage` user fabricate customer messages and orders drafts in a real inbox, so never set it next to real
customers' data. Every response of the integration carries `mode`; every mock connection, event and draft
carries `mock: true` so screens can label it.

| Mock mode (default)                                                                                                                  | Live mode                                                                                                                                                                         |
| ------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `POST /v1/integrations/meta/mock/connection` makes a labelled connection (no OAuth, no token, `mock_...` account id).                | `POST .../mock/connection` and `.../mock/events` are **404**.                                                                                                                     |
| `POST /v1/integrations/meta/mock/events` injects a synthetic message through the **same** `ingestEvents` pipeline as a real webhook. | Real messages arrive at `POST /v1/webhooks/meta`.                                                                                                                                 |
| Signature verification is skipped for injected events only because they never come from Meta.                                        | Signature verification is mandatory.                                                                                                                                              |
| `POST .../oauth/start` and reconnect: 409 `meta_not_configured`.                                                                     | Sign-in with Meta, Page tokens, subscription, health check.                                                                                                                       |
| The real webhook route works too **if `META_APP_SECRET` is set** (used by the tests, with signed synthetic payloads).                | Needs `META_APP_ID`, `META_APP_SECRET`, `META_WEBHOOK_VERIFY_TOKEN`, `META_GRAPH_VERSION`, `API_PUBLIC_URL`, `COURIER_CREDENTIALS_KEY`. The server refuses to start without them. |

Try it without any Meta account: `pnpm meta:demo` (needs `pnpm db:seed`). It makes a mock connection, injects a Bangla order
message, prints the draft, confirms it through the service the API uses, replays the identical message twice and prints the counts
(one event, one draft, one order). With `--url http://localhost:4000` and `META_APP_SECRET` set it also POSTs a correctly signed
webhook (twice) to a running API. To send a signed sample by hand: `pnpm meta:send-webhook --account <page id> --text "..."`.

## Activation checklist

Use accounts that have a **role on the Meta app** (developer or tester): until App Review, only they can connect.

1. **Create a Meta app** at developers.facebook.com (type: Business). Note the **App ID** and **App Secret** (Settings > Basic).
2. **Add use cases / products**: Facebook Login for Business (or Facebook Login) and Messenger (Instagram messaging via the
   Page). Enable the permissions of the [table above](#permission-scopes).
3. **Facebook Login redirect URI**: add `https://<API_PUBLIC_URL>/v1/integrations/meta/oauth/callback` (exact match). For Facebook
   Login for Business create a login configuration with the five permissions and set `META_LOGIN_CONFIG_ID` (**verify**).
4. **Webhooks**: in the dashboard add the **Page** webhook with callback URL `https://<API_PUBLIC_URL>/v1/webhooks/meta` and the
   **verify token** you chose (`META_WEBHOOK_VERIFY_TOKEN`, 16+ characters). For Instagram enable the `messages` field of the
   Instagram webhook with the same callback (**verify**). Fields OrderLoop subscribes per Page itself: `messages`,
   `messaging_postbacks`.
5. **Deauthorize and data deletion**: in the dashboard set the Deauthorize callback to
   `https://<API_PUBLIC_URL>/v1/webhooks/meta/deauthorize` and the Data Deletion Request callback to
   `https://<API_PUBLIC_URL>/v1/webhooks/meta/data-deletion`. Also set the **privacy policy URL** (your page must describe what is in
   [data handling](#data-handling)).
6. **Add testers/roles** (App roles) for everyone who will connect, and make sure they can perform the `MODERATE` task on the Page.
7. **Set the environment** (API and worker): `META_MODE=live`, `META_APP_ID`, `META_APP_SECRET`, `META_WEBHOOK_VERIFY_TOKEN`,
   `META_GRAPH_VERSION` (a supported version), `API_PUBLIC_URL` (https), `WEB_APP_URL`, `COURIER_CREDENTIALS_KEY`. Restart.
8. **Instagram**: the account must be a professional account, linked to the Page, with **Allow Access to Messages** on (Instagram
   settings > Messages and story replies > Message controls > Connected tools).
9. **Test with authorised accounts**: in the app, Integrations > connect with Meta, choose the Page; message the Page from another
   account; check that a draft appears (and that nothing else is stored).
10. **App Review** (to serve other businesses, i.e. be a Tech Provider): each permission needs a usage description, a screencast of
    the whole flow, and at least one successful API call; the submission needs a 1024x1024 icon, privacy policy URL, category,
    business email and step-by-step test instructions. **Business Verification** is probably needed too: **verify**.
11. **Rotate the app secret**: change it in the dashboard, then set `META_APP_SECRET` in the API and the worker and restart. Webhooks
    signed with the old secret get 401 until then (Meta retries; keep the gap short). Saved Page tokens are not invalidated by a secret
    change, but verify by running the health check. **Rotate the verify token**: set the new value in the dashboard first and in
    `META_WEBHOOK_VERIFY_TOKEN` second; the handshake is only used when (re)subscribing.
12. **Staging verification before enabling live (do not skip).** The live path was written from Meta's documentation and has
    never run against real payloads ([M4](#not-verified)). Before `META_MODE=live` on production, run a **staging** deployment
    (its own Meta app in development mode, `https` API, the same `TRUST_PROXY` and secrets handling as production) and tick every box:
    - [ ] A real message to the Page, and to the linked Instagram account, arrives with **HTTP 200** and a valid
          `X-Hub-Signature-256`; check the logs for `invalid_signature` (the raw and the `\uXXXX`-escaped forms are both tried:
          note which one verified, and test a message with Bangla text, an emoji and a `/`).
    - [ ] Instagram events arrive with only the Page subscribed (or note what extra subscription was needed).
    - [ ] Sign in with Meta from the web app: `begin` sets the cookie, the callback returns with `session=`, the Pages list shows
          names only; try from a browser that blocks third-party cookies and one that does not.
    - [ ] The dialog type (`config_id` or classic `scope`) your app needs works, and every permission in the table is granted.
    - [ ] "Allow Access to Messages" off produces the expected `meta_messages_access_off` (the wording match is a guess).
    - [ ] Deauthorize and data-deletion callbacks verify with a real `signed_request` from the dashboard's test button.
    - [ ] The daily health check reports the connection `active` and reads the Page token's scopes.
    - [ ] A conversation of three or four messages makes one draft with the right phone, address and items; a long paste or a
          wall of digits (over 500 characters in one message) is cut, not hung on.
          Record the date and the findings in this file. Only then set `META_MODE=live` in production.
13. **If Meta reports "Webhooks Disabled"** (1 hour of failures): fix the cause, then reconnect the account (Integrations >
    reconnect), which subscribes the Page again.

## Sign-in flow and why it has a begin step

```
web app --POST /oauth/start (bearer)--> API   -> { authorizeUrl: API/oauth/begin?ticket=T }      (T: random, 60 s, single use,
                                                  stored in Redis only as a hash; the signed state is stored with it)
browser --GET  /oauth/begin?ticket=T-----> API   -> Set-Cookie: ol_meta_oauth=<HMAC of the state's nonce>; HttpOnly; SameSite=Lax;
                                                  Path=/v1/integrations/meta/oauth; Secure in production; Max-Age = state life
                                                  302 -> Meta's dialog (with the signed state)
Meta    --302 /oauth/callback?code&state--> browser --GET (cookie sent: top-level navigation, Lax)--> API
                                                  state signature + expiry + single use + COOKIE must match; cookie cleared
                                                  302 -> {WEB_APP_URL}/settings/integrations/meta?session=<id> | ?error=<code>
```

**Why.** The state alone proves the flow was started by a signed-in person of some business, not that the browser finishing it is
the one that started it. Without a binding, an attacker who is an admin of business X can start a sign-in, then send the Meta
dialog URL (it contains X's valid state) to an admin of business Y. If that person approves, Meta sends **Y's** Page access to the
callback, which attaches it to a sign-in session of **X**: the attacker can then connect Y's Pages (and read Y's customers'
messages) in X. The cookie closes that: only the browser that went through `begin` holds it, and the callback refuses (redirect
with `error=invalid_state`, nothing exchanged, the state not consumed) when it is missing or does not match. The cookie is set by
the API on its **own origin** during a top-level navigation and read back on another top-level navigation, so it works with
third-party-cookie blocking and needs no change to CORS. The cookie value is an HMAC (keyed with `META_APP_SECRET`) of the state's
nonce: seeing the state, or Meta's URL, is not enough to forge it.

**Why a ticket and not a cookie set by `start`.** `start` is an authenticated `fetch` from the web app (another origin): a cookie it
sets would be third-party, which browsers increasingly drop, and it would bind the flow to the `fetch`, which is the same browser
but not necessarily the same window or app (the mobile app opens the link in the system browser). The one-time ticket moves the
cookie to a navigation the person actually performs.

**Limits (accepted).** If the attacker forwards the **`begin` link** itself (not Meta's URL) and the victim opens it within its 60 seconds, the
victim's browser receives the cookie and the rest proceeds for the attacker's business, so the flow still depends on the victim not
approving a Meta dialog they did not start; the ticket's short life and single use keep that window small, and the dialog names the
app. A ticket is bound to nobody; binding it to the starter's user agent or IP was rejected as fragile (mobile networks, in-app
browsers). If Redis is down, `start` answers `meta_unavailable` (no state is usable without its ticket).

## Webhooks

- `GET /v1/webhooks/meta`: the handshake. Constant-time verify-token compare; anything else is 403.
- `POST /v1/webhooks/meta`: the body is read **raw** (`express.raw`, 512 KB cap; JSON parsing never runs for this route), the
  signature is checked first (raw bytes and the `\uXXXX`-escaped variant, constant time), and a missing or invalid signature is 401
  without parsing anything. Per-address rate budget 1200/minute (Meta bursts when it retries). Unknown Page / Instagram ids,
  disconnected connections and unsupported events get **200** and store nothing. With no `META_APP_SECRET` the route is 404.
- `POST /v1/webhooks/meta/deauthorize` and `/data-deletion`: form-encoded `signed_request`, HMAC-SHA256 verified; see
  [data handling](#data-handling). `GET /v1/webhooks/meta/data-deletion/status?code=` is the status URL Meta is given.

## Extraction

`extractDraft(messages, catalog)` in `packages/domain/src/social-extract.ts`. Pure, deterministic, no model, no network.

- **Phone**: Bangladeshi mobile numbers in English and Bangla digits (`01712345678`, `+8801712345678`, `8801...`, spaces and dashes),
  normalised to `+8801XXXXXXXXX` (the app's format). More than one distinct number lowers the confidence and adds
  `multiple_phones`.
- **Bounded work**: customer text is hostile input. Extraction reads at most **500 characters per message** and **4,000 per
  conversation** (`MAX_MESSAGE_CHARS`, `MAX_DRAFT_CHARS`; ingest already stores at most 2,000 per message), a phone number is
  looked for in at most 15 characters over 12 digit groups, so the time is linear in the text (a 2,000-character run of spaced
  digits used to take cubic time and block the worker). A number that starts after the first 500 characters of a message is not found.
- **Address**: filled **only** when a line or comma-part carries an address word (বাসা, রোড, ঠিকানা, থানা, house, road, holding,
  thana, flat, block, village, ...) or a district name; the run from the first to the last such part is kept, minus phone and name
  parts. Otherwise empty (`no_address`). **District** from a list of the 64 districts (English spellings and Bangla names, also with
  Bangla endings such as ঢাকায়), with a suggested division.
- **Name**: from `name:` / `নাম:`; otherwise a bare name line in a message that also has a number, at confidence 0.5.
- **Items**: SKU exactly (confidence 1) or normalised name tokens (Bangla and English) against this business's variants. A match is
  accepted only at score 0.65 or more **and** clearly ahead of the runner-up; otherwise the text stays a free-text line
  (`variantId: null`, `unmatched_item`) for the reviewer to map. Quantities: `2 pcs`, `২টা`, `x2`, `2x`, `qty 3`, `দুই`, `two`,
  `1 dozen`. A later mention of the same item corrects its quantity.
- **Prices are never trusted**: the draft has no price; a price in the chat only adds `price_ignored`. The order's prices come from
  the catalogue.
- A draft is created only when the conversation **looks order-like** (a phone number, a matched product, or an order word such as
  `order`, `অর্ডার`, `নিব`, `চাই`). Otherwise the event is `ignored` and its text is removed.

Honest limits: it is a heuristic. Different spellings of a product, romanised Bangla ("tshirt", "panjabi"), several addresses in
one message and names that look like words will be missed or low-confidence. That is why a person always confirms.

## Drafts

One **open** draft (`needs_review`) per (connection, customer): later messages are added and extraction re-runs; what a person
typed (`PATCH`) is kept separately (`overrides`) and wins over extraction, so it survives new messages.

`POST /v1/social-drafts/:id/confirm` takes the same body as `POST /v1/orders` (the reviewer completes the customer, address, items;
`confirm: true` reserves stock) and creates the order through `OrdersService.createWithin`, the code path manual entry uses: same
validation, stock reservation, duplicate rules, audit and automation event. The draft is linked **in the same transaction**; if the
order fails (for example not enough stock) nothing happens and the draft stays open. The draft row is locked first, so two confirms
take turns and the second returns the same order. Reusing an idempotency key that already made an order for **another** draft is
409 `idempotency_conflict`. The order's `source` is `facebook` or `instagram` (mock drafts: `other`) and its `sourceReference` names
the draft; it holds no chat text.

**Duplicate warnings** on a draft: the normal order duplicate check (same phone and same item or placed in the last ten minutes) plus
orders already made from the same customer's chat on that connection in the last 72 hours.

## Connection health

A BullMQ scheduler (`meta-health`, once a day, one job however many workers run) checks every live connection: `debug_token`,
then a plain read of the Page. Invalid token (190, or `is_valid: false`) -> `needs_reconnect`; permission codes (10, 200, 299) or a
missing scope -> `permission_error`; works again -> `active` (error cleared). Rate limits and outages change nothing. Each change
is recorded (`last_error_code`, a sentence with no token, `last_checked_at`) and audited (`integration.needs_attention`, ids only).

**No in-app notification.** The notification kinds are the `AutomationKind` enum (a database enum, the rule model and the
preferences screens all key on it); adding `INTEGRATION_ATTENTION` would touch the rule engine, the preferences contract and every
screen that lists kinds, which is not cheap. Instead the status shows on the Integrations screen and in `GET /v1/integrations/meta`.
A later change can add the notification kind. **Instagram-Login 60-day token refresh is not needed** for this flow (Page tokens from a
long-lived user token do not expire), see [not verified](#not-verified).

## Data handling

What is stored, for how long, and why:

| Data                      | Where                                 | Notes                                                                                                                                  |
| ------------------------- | ------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| Page token                | `social_connections.access_token_enc` | AES-256-GCM, bound to the business and provider, same key as courier credentials. Never returned, never logged. Deleted on disconnect. |
| Sign-in hand-over         | `social_oauth_sessions`               | Hashed state, sealed user token (cleared once used), page names and ids. Expires in 10 minutes; deleted a day after.                   |
| A customer's message text | `social_events.payload`               | Only for order-like conversations. Only the **kind** of an attachment is kept: no media is downloaded, no URL is stored.               |
| Customer's id             | `sender_id`                           | An opaque page-scoped / Instagram-scoped id. No name, profile or phone beyond what the customer typed in a message.                    |
| Extracted fields          | `social_drafts.extracted/overrides`   | Phone, address, items, with the message ids they came from.                                                                            |
| Chit-chat                 | nowhere                               | An event that is not order-like is `ignored` and its text removed at once. Echoes are never read.                                      |

**Retention** (`META_RETENTION_DAYS`, default 30; the worker runs it hourly through `purge_social_data`): drafts nobody confirmed
(by last message), and dismissed or confirmed drafts (by last change), older than that are deleted; events older than that are
deleted unless their conversation still has an open draft; expired sign-in hand-overs go a day after expiry. A **confirmed order keeps
no copy of the chat**: it holds only what a person typed in the order form. Orders are never deleted by this.

**Deauthorize callback**: disconnects every connection made by that person (`meta_user_id`) and deletes the stored tokens.
**Data deletion callback**: for a person who connected accounts, disconnects them and deletes every stored event and draft of those
connections; for an id that is a customer in conversations, deletes that customer's events and drafts. It answers
`{url, confirmation_code}`; the code is a keyed hash, the URL a status page that always reads `completed` (deletion is immediate).
Audit rows (ids only, never message text) are kept.

## Limits

What OrderLoop cannot see or do, by design or because Meta does not provide it:

- **No history.** Historical notifications cannot be queried later: only messages delivered after a connection is made are seen, and
  missed deliveries (for example while the webhook was failing for an hour) are gone.
- **Only conversations with the business**, only for the connected Pages / accounts. Nothing from the seller's other conversations.
- **No profile names.** OrderLoop does not call Meta for the customer's name or picture; the draft name comes from what they wrote.
- **No replies.** Receive-only: the seller answers in Meta's own inbox. The 24-hour messaging window and the Human Agent tag matter
  only for sending; they are out of scope and described nowhere on the pages read (**future work**).
- No media, no stories, no comments, no ads.
- Until App Review, only people with a role on the Meta app can connect.

## Configuration

| Variable                                                   | Notes                                                                                                                                          |
| ---------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| `META_MODE`                                                | `mock` (default outside production; **required explicitly in production**) or `live`. Live fails to start unless all of the following are set. |
| `META_ALLOW_MOCK_IN_PRODUCTION`                            | Default `false`. Pilot demos only: keeps the mock endpoints (404 in production otherwise) available with `META_MODE=mock`.                     |
| `META_APP_ID`                                              | Numeric app id.                                                                                                                                |
| `META_APP_SECRET`                                          | 16+ characters. Signs webhooks, OAuth state and the two callbacks. Without it the webhook and callbacks are 404.                               |
| `META_WEBHOOK_VERIFY_TOKEN`                                | 16+ characters; the same string as in the dashboard.                                                                                           |
| `META_GRAPH_VERSION`                                       | `v<major>.<minor>`, no default: pin a version that is currently supported.                                                                     |
| `META_LOGIN_CONFIG_ID`                                     | Optional: Facebook Login for Business configuration id (replaces `scope` in the dialog).                                                       |
| `META_RETENTION_DAYS`                                      | Default 30 (1 to 365).                                                                                                                         |
| `API_PUBLIC_URL`, `WEB_APP_URL`, `COURIER_CREDENTIALS_KEY` | Callback URLs, where the sign-in returns to (default: first `WEB_ORIGINS`), and the key that seals tokens.                                     |

## UI contract

For the screens (web and mobile), everything the API gives:

- **Overview** `GET /v1/integrations/meta` (`integrations:read`): `{ mode, liveConfigured, webhookUrl, scopes[], connections[], openDrafts }`.
  A connection: `{ id, provider: facebook_page|instagram, externalId, displayName, username, linkedPageId, status, mock, scopes[],
tokenExpiresAt, lastCheckedAt, lastErrorCode, lastErrorMessage, connectedAt, disconnectedAt }`.
  **Statuses**: `active`; `needs_reconnect` (show "Reconnect"); `permission_error` (show "Reconnect and approve all permissions");
  `disconnected` (listed, with "Connect again"). `lastErrorCode` is `token_invalid` or `permission_denied`.
- **Connect (live)**: `POST /v1/integrations/meta/oauth/start` -> `{ mode, authorizeUrl }`; send the browser to `authorizeUrl` as a
  **top-level navigation** (`window.location`, not `fetch`/XHR or an iframe). It is a one-time link to the API, not Meta's URL
  (see [Sign-in flow](#sign-in-flow-and-why-it-has-a-begin-step)); there is no `state` in the response any more.
  Meta returns to the API, which redirects to **`{WEB_APP_URL}/settings/integrations/meta?session=<uuid>`** or
  **`...?error=<code>`** with `code` in `access_denied | invalid_state | meta_not_configured | meta_permission_denied |
meta_token_invalid | meta_unavailable | rate_limited`. Then `GET .../oauth/sessions/:id` -> `{ mode, id, expiresAt, pages[{ id, name,
instagram: {id, username}|null, alreadyConnected }], reconnectConnectionId }` (names and ids only), and
  `POST .../connections { sessionId, pageIds[] }` -> `201 { mode, connections[], failures[{ pageId, code, message }] }`. Selecting a Page
  connects its linked Instagram account too. If every Page fails the call is an error with that code instead.
- **Reconnect**: `POST .../connections/:id/reconnect` -> the same `{ mode, authorizeUrl }`; the session then only allows that account.
  **Disconnect**: `DELETE .../connections/:id` (idempotent).
- **Mock (mock mode only)**: `POST .../mock/connection { provider?, displayName? }` -> connection; `POST .../mock/events { connectionId,
senderId?, text?, attachmentTypes?, messageId?, timestamp? }` -> `{ mode, mock: true, eventId, messageId, duplicate, status, draftId }`.
  Label everything with `mock: true` ("Mock" badge) and the `mode` ("Demo mode: nothing reaches Meta").
- **Drafts**: `GET /v1/social-drafts?status=needs_review|confirmed|dismissed&cursor=&limit=` (`orders:read`) -> `{ mode, items[summary],
nextCursor, counts{needs_review,confirmed,dismissed} }`. Summary: `{ id, status, mock, provider, connectionId, connectionName,
senderId, customerName, phone, snippet, itemCount, unmatchedItemCount, messageCount, firstMessageAt, lastMessageAt, orderId,
orderNumber }`. `snippet` is the first 60 characters of the first customer message that has text (`null` if none): a list label, no other
  customer data. `orderNumber` is the linked order's number once confirmed, else `null`.
  `GET /v1/social-drafts/:id` -> summary plus `{ mode, fields{ customerName?, phone?, address?, district?, area?, postalCode?, note?, codAmountMinor?:
{value, confidence 0..1, sourceEventIds[], edited}, items[{ variantId|null, text, quantity, confidence, sourceEventIds, edited,
match: {sku, productName, variantName, priceMinor, available}|null }] }, suggestedDivision, warnings[{code, message}], messages[{ id, text|null,
attachmentTypes[], at }], duplicates[PotentialDuplicate], dismissedReason, reviewedAt, createdAt }`.
  **Warning codes**: `no_phone`, `multiple_phones`, `no_address`, `no_items`, `unmatched_item`, `low_confidence_item`, `price_ignored`,
  `duplicate_order`. Show low `confidence` fields (< 0.7, `CHECK_THIS_CONFIDENCE` in `@orderloop/domain`; also the cut-off for `low_confidence_item`) as "check this". The items need every `variantId` set before confirming
  (the API does not stop an order with unmapped text lines; the order body needs `variantId`s anyway).
- **Edit**: `PATCH /v1/social-drafts/:id` (`orders:write`) with any of `customerName, phone, address, district, area, postalCode, note, codAmountMinor`
  (`null` removes the edit) and `items[{ variantId|null, text, quantity }]` (replaces the list) -> the draft. `400` on a bad phone or an
  unknown variant.
- **Confirm**: `POST /v1/social-drafts/:id/confirm` with the **order create body** (`customer`, `address`, `items`, `confirm?`,
  `idempotencyKey`, ...) -> `{ draft, order }`. Generate the idempotency key once per attempt and reuse it on retry. Prefill the form from
  `fields` (including `area`, the thana, and `postalCode`: both are typed by a person, extraction leaves them empty) and `suggestedDivision`. Second confirm returns the same order. **Dismiss**: `POST .../dismiss { reason? }` -> draft.
- **Error codes** (all in [api.md](api.md#errors)): `meta_not_configured` 409, `meta_oauth_invalid` 400, `meta_permission_denied` 422,
  `meta_instagram_not_linked` 422, `meta_messages_access_off` 422, `meta_token_invalid` 409, `meta_unavailable` 502, `conflict` 409
  (account already connected elsewhere), `draft_closed` 409, `idempotency_conflict` 409, plus the usual order errors
  (`insufficient_stock`, `validation_failed`).

## Troubleshooting

| Symptom                                                | Check                                                                                                                                                                                                                                 |
| ------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Dashboard says the callback URL could not be verified  | `META_WEBHOOK_VERIFY_TOKEN` equals the dashboard's token; `API_PUBLIC_URL` is reachable from the internet over https; the API log shows `Verification failed` (403).                                                                  |
| Every delivery is 401 in the log ("invalid signature") | `META_APP_SECRET` is the app's current secret (also set for the API, not only the worker); a proxy is not changing the body.                                                                                                          |
| Connecting says `meta_permission_denied`               | The person has no `MODERATE` task on the Page, has no role on the Meta app, or did not approve every permission in the dialog.                                                                                                        |
| Connecting says `meta_messages_access_off`             | Instagram: turn on Allow Access to Messages (settings above). The detection is by wording only (**unverified**); a generic failure may be the same cause.                                                                             |
| `conflict` when connecting                             | That Page or Instagram account is connected to another business. Disconnect it there first.                                                                                                                                           |
| Connection says `needs_reconnect`                      | The token was revoked or expired (password change, app removed). Reconnect.                                                                                                                                                           |
| Messages arrive in Meta but no draft appears           | Webhook subscribed for the Page (and the Instagram `messages` field)? The message may not look order-like (no number, item or order word): check `social_events.status`/`error`; the worker is running and `meta-events` is draining. |
| Events stay `received`                                 | The worker is not running or Redis is down; the sweeper queues them within about a minute once it is.                                                                                                                                 |
| Meta sent "Webhooks Disabled"                          | The webhook failed for an hour: fix it, then reconnect the account to subscribe again. Messages in between are lost (no history API).                                                                                                 |

## Known limitations

- Receive-only. Replies, the 24-hour window and the Human Agent tag are future work.
- Live path unproven against real Meta; see [not verified](#not-verified).
- Extraction is a heuristic (see above); no machine learning on purpose.
- The first message of a conversation that is not order-like is dropped: if the customer then sends an order, the draft starts from
  that message. Messages that arrive together are judged together.
- No in-app notification for a connection that needs attention (see [connection health](#connection-health)).
- A customer who deletes their Meta account or asks Meta for deletion is not signalled to us except through the data-deletion
  callback.
- The per-IP throttle is per instance (in memory), like the rest of the API's per-IP limits; see [api.md](api.md#rate-limiting-and-lockout) for which limits are in Redis and the Redis store to use with several replicas.
