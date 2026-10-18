# API reference

The OrderLoop REST API (NestJS). This page explains how it behaves; the exact request and response shapes are in
[openapi.json](openapi.json), which is generated from the same route registry
(`packages/contracts/src/routes.ts`) the server and the typed client use, and which a test keeps current. The running
server also serves it at `GET /openapi.json`.

Related: [database.md](database.md) (data model and tenant isolation), [architecture.md](architecture.md) (decisions).

- Base URL in development: `http://localhost:4000`. All application routes are under `/v1`.
- JSON in, JSON out. Send `content-type: application/json`.
- Every response carries an `x-request-id` header (a well-formed one you send is echoed; otherwise one is generated). Quote it when reporting a problem; it appears in the server log.

## Concepts

**Terminology.** The product calls a customer's workspace a business; the code and database call it a **tenant**, and
a person's link to it a **membership** (`Tenant`, `Membership`). They are the same thing. A person (`User`) can belong to
several tenants with a different role in each.

**Identity comes only from the token.** The API never trusts a user id, tenant id or role sent by the client. The user,
tenant and session come from the signed access token; the role comes from the database, read on every request.

### Tokens

| Token                           | Lifetime                     | Where it lives                                         | Notes                                                                                      |
| ------------------------------- | ---------------------------- | ------------------------------------------------------ | ------------------------------------------------------------------------------------------ |
| Access token (JWT, EdDSA)       | 15 minutes                   | Memory. Sent as `Authorization: Bearer <token>`        | Carries only user id, tenant id and session id. Revoked sessions stop working immediately. |
| Refresh token (opaque, 256-bit) | 30 days, 90 days per session | Native apps: secure storage. Browsers: HttpOnly cookie | Single use: every refresh returns a new one. Stored only as a SHA-256 hash.                |
| Email verification token        | 24 hours                     | Emailed link                                           | Single use; a newer link replaces older ones. Stored only as a hash.                       |
| Password reset token            | 1 hour                       | Emailed link                                           | Single use; a newer link replaces older ones. Stored only as a hash.                       |
| Invitation token                | 7 days                       | Emailed link                                           | Single use; bound to its inviter's authority. Stored only as a hash.                       |

Plaintext passwords and tokens are never stored and never logged. Passwords are hashed with argon2id.

**Browser vs native clients.** Send `x-client: web` from a browser. The refresh token is then set as an
`HttpOnly; SameSite=Lax; Path=/v1/auth` cookie (`Secure` in production) and is never present in JSON; the refresh
endpoint reads the cookie and also checks the `Origin` against `WEB_ORIGINS`. Native apps omit the header and receive
`refreshToken` in the response body.

**Refresh-token reuse detection.** Presenting a refresh token that was already exchanged is treated as theft: the whole
session is revoked and the call fails with `token_reuse_detected`. Both the attacker and the legitimate holder must
sign in again. Two simultaneous refreshes of one token behave the same way (exactly one succeeds).

### Errors

Every error is [RFC 9457](https://www.rfc-editor.org/rfc/rfc9457) problem details with the media type
`application/problem+json`, plus a stable machine-readable `code`:

```json
{
  "type": "urn:orderloop:error:validation_failed",
  "title": "validation_failed",
  "status": 400,
  "code": "validation_failed",
  "detail": "Request validation failed",
  "errors": [{ "path": "body.password", "message": "Use at least 10 characters" }]
}
```

`errors` appears only for validation failures; `path` is `body.*`, `query.*` or `params.*`. Unexpected failures return
`500 internal_error` with no detail; the cause is in the server log under the same `x-request-id`.

| `code`                 | Status | Meaning                                                                                                      |
| ---------------------- | ------ | ------------------------------------------------------------------------------------------------------------ |
| `validation_failed`    | 400    | Body, query or path failed validation. See `errors`.                                                         |
| `invitation_invalid`   | 400    | Invitation unknown, used, expired, revoked, or its inviter lost the authority to grant it.                   |
| `token_invalid`        | 400    | Verification or reset link unknown, used, expired, or for another purpose. Deliberately uniform.             |
| `unauthorized`         | 401    | Missing, malformed or invalid access token, or the session/membership/account is no longer valid.            |
| `token_expired`        | 401    | Access token expired (refresh it), or the refresh session has ended.                                         |
| `invalid_credentials`  | 401    | Wrong email or password. Same answer for unknown email, disabled account and wrong password.                 |
| `token_reuse_detected` | 401    | A used refresh token was presented again. The session is revoked.                                            |
| `forbidden`            | 403    | Authenticated, but your role lacks the permission.                                                           |
| `email_not_verified`   | 403    | Verify your email address first (currently required to invite people).                                       |
| `not_found`            | 404    | Resource does not exist **or belongs to another tenant** (the two are indistinguishable).                    |
| `conflict`             | 409    | For example the email is already registered, or the person is already a member.                              |
| `last_owner`           | 409    | The change would leave a tenant without an owner.                                                            |
| `insufficient_stock`   | 409    | Not enough available stock for a reservation or a downward adjustment. `detail` says how many are available. |
| `rate_limited`         | 429    | Too many requests or failed sign-ins. See `Retry-After`.                                                     |
| `internal_error`       | 500    | Unexpected. Quote the `x-request-id`.                                                                        |

## Authentication endpoints

All are under `/v1/auth`. "Public" means no access token is needed.

### `POST /v1/auth/register` (public, 201)

Creates a user and a new tenant they own, signs them in, and emails a verification link.
Body: `email`, `password` (10 to 128 characters, no composition rules), `name`, `tenantName`.
Returns `AuthResult`: `accessToken`, `expiresIn`, `refreshToken` (native only), `user` (including `emailVerified: false`),
`tenant`, `role` (`OWNER`), `memberships`. Errors: `validation_failed`, `conflict` (email taken).
The user can sign in and use the API before verifying, with one restriction: inviting people needs a verified email.

### `POST /v1/auth/login` (public)

Body: `email`, `password`, optional `tenantId` (defaults to the most recently joined tenant). Returns `AuthResult`.
Errors: `invalid_credentials`, `rate_limited` (see lockout below), `forbidden` (not a member of the requested tenant, or no tenant).

### `POST /v1/auth/refresh` (public)

Body: `{ "refreshToken": "..." }` for native clients; browsers send `x-client: web` and an empty body (the cookie is used).
Returns a new `AuthResult` with a **new** refresh token; the old one is now dead. Errors: `unauthorized`, `token_expired`,
`token_reuse_detected`, `forbidden` (cookie transport from a disallowed origin).

### `POST /v1/auth/logout` (access token)

Revokes the session at once: the access token and refresh token both stop working. Clears the browser cookie.

### `POST /v1/auth/verify-email` (public)

Body: `{ "token": "..." }` from the verification email. Marks the address verified. The token works once.
Error: `token_invalid`.

### `POST /v1/auth/resend-verification` (access token)

Sends a new verification email and invalidates the previous link. Does nothing if already verified, and nothing if a
link was issued in the last 60 seconds. Always returns 200 `{}`.

### `POST /v1/auth/forgot-password` (public)

Body: `{ "email": "..." }`. **Always answers 200 `{}`** whether or not the address has an account, so it cannot be used to
find out who is registered. If the account exists and is active, a reset link (valid 1 hour) is emailed. Known and unknown
addresses do identical work before the response; issuing the token and sending the email happen afterwards, so neither the
body nor the response time reveals whether the account exists. At most three reset emails per address per hour are sent
(further requests still answer 200). Earlier links stay valid, so someone else requesting resets for your address cannot
kill the link you already have; using any one expires the rest. Unauthenticated requests are not written to any tenant's
audit log.

### `POST /v1/auth/reset-password` (public)

Body: `{ "token": "...", "password": "..." }`. Sets the new password (same rules as registration), **revokes every session of
that user on every device**, expires other reset links, marks the email verified (receiving the link proves control),
records an audit event in each of the user's tenants, and emails a "your password was changed" notice. The user then
signs in again; no session is created. A too-weak password is rejected without using up the link. Error: `token_invalid`.

### `POST /v1/auth/switch-tenant` (access token)

Body: `{ "tenantId": "..." }`. Re-scopes the session to another tenant the user belongs to and returns a new `AuthResult`
(no new refresh token). The previous access token stops working. Error: `forbidden` (also returned for tenants that do not
exist, so ids cannot be probed).

### `POST /v1/auth/accept-invitation` (public, 201)

Body: `token`, `password`, and `name` (required only if the invited address has no account yet). A new account is created
with a verified email; an existing account must supply its current password. Errors: `invitation_invalid`,
`invalid_credentials`, `conflict`, `validation_failed`.

## Other endpoints

| Method and path                       | Needs                           | Purpose                                                                                                                                                                            |
| ------------------------------------- | ------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /health/live`                    | nothing                         | Liveness. 200 while the process runs.                                                                                                                                              |
| `GET /health/ready`                   | nothing                         | Readiness. 200, or 503 `degraded` when PostgreSQL or Redis is down.                                                                                                                |
| `GET /openapi.json`                   | nothing                         | This API as OpenAPI 3.1.                                                                                                                                                           |
| `GET/PATCH /v1/me`                    | access token                    | User (with `emailVerified`, `language`), current business summary, role, permissions, memberships. `PATCH` sets your own language.                                                 |
| `GET/PATCH /v1/tenant`                | `tenant:read` / `tenant:update` | The current business profile (name, logo link, contact, address, currency, time zone, language); `PATCH` is partial, `null` clears an optional field, audited as `tenant.updated`. |
| `GET/POST /v1/workspaces`             | access token                    | The businesses you belong to with your role in each; create another (you become its OWNER, max 10 owned). Enter it with `POST /v1/auth/switch-tenant`.                             |
| `GET /v1/members`                     | `members:read`                  | Members of the current tenant.                                                                                                                                                     |
| `GET/POST /v1/members/invitations`    | `members:invite` (OWNER, ADMIN) | List pending, or invite by email. Inviting needs a verified email.                                                                                                                 |
| `DELETE /v1/members/invitations/{id}` | `members:invite`                | Revoke a pending invitation.                                                                                                                                                       |
| `PATCH/DELETE /v1/members/{id}`       | `members:manage` (OWNER, ADMIN) | Change a role, or remove a member. An ADMIN cannot touch OWNERs or ADMINs; a tenant keeps at least one OWNER.                                                                      |
| `GET /v1/audit-logs`                  | `audit:read` (OWNER, ADMIN)     | Tenant audit trail, newest first, cursor paginated (`limit` 1 to 100).                                                                                                             |

Roles are `OWNER`, `ADMIN`, `MANAGER`, `STAFF`, `ACCOUNTANT`. The full permission matrix, role-assignment rules, tenant-isolation
layers and audit events are in [permissions.md](permissions.md); the code is `packages/domain/src/permissions.ts`.

## Catalog, stock and imports

Everything below is per tenant: you only ever see and change your own business's data, whatever ids you send. Routes need an
access token and a permission:

| Role         | Read catalog and stock | Change catalog (products, variants, categories, locations, imports) | Move stock (receive, adjust, reserve, release, fulfil) |
| ------------ | :--------------------: | :-----------------------------------------------------------------: | :----------------------------------------------------: |
| `OWNER`      |          yes           |                                 yes                                 |                          yes                           |
| `ADMIN`      |          yes           |                                 yes                                 |                          yes                           |
| `MANAGER`    |          yes           |                                 yes                                 |                          yes                           |
| `STAFF`      |          yes           |                                 no                                  |                          yes                           |
| `ACCOUNTANT` |          yes           |                                 no                                  |                           no                           |

Permissions are `catalog:read`, `catalog:write`, `inventory:read`, `inventory:write`. Suppliers and CSV export of the catalog follow
`catalog:read` / `catalog:write`; the stock export follows `inventory:read`; damage, write-off and return follow `inventory:write`.
The full inventory design, including the contract for the future orders and returns workflows, is in
[inventory.md](inventory.md).

### Products, variants and money

A **product** (name, description, category, supplier, picture links, unit) has one or more **variants** (SKU, name, size and colour
attributes, price, cost, barcode, reorder threshold); a variant is one sellable, countable SKU. Stock belongs to
variants, never to products. Create a product with at least one variant in a single call; later add variants with
`POST /v1/products/{id}/variants`.

- **Money is integer paisa** (1 BDT = 100 paisa): `"priceMinor": 125050` is ৳1,250.50. Decimals, negatives and amounts above
  2,000,000,000 paisa are rejected with `validation_failed`. Never send floats.
- **SKUs** are upper-cased and trimmed on the way in (`" tee-red "` becomes `TEE-RED`), must match
  `[A-Z0-9][A-Z0-9._-]{0,63}`, are **unique per business** (case-insensitively), and **never change** once created.
  Two businesses may use the same SKU. A taken SKU is `409 conflict`.
- **Units:** `pcs`, `kg`, `g`, `l`, `ml`, `m`, `pack`, `dozen`. A product has one unit; all its variants share it.
- **Pictures** are `imageUrls`: up to 8 `https://` links, the first is the main one. Pictures are links, not uploads; there is no
  file storage yet. **Size and colour** are variant `attributes` (`{ "size": "M", "colour": "Red" }`), and a variant
  created with them but no name is shown as `Red / M`.
- **Suppliers** (`GET/POST /v1/suppliers`, `PATCH /v1/suppliers/{id}`): name (unique per business, case-insensitively), contact
  person, phone, email, address, notes. A product may name one (`supplierId`); an archived or another business's supplier
  is `400 validation_failed`. Archiving a supplier keeps the history.
- **Categories:** unique names per business, case-insensitively. Deleting one leaves its products uncategorised.
- **Archiving:** set a product's `status` to `ARCHIVED`, or a variant's `archived` to `true`. Archived items stay in history but
  cannot take stock or reservations (a variant is also refused when its **product** is archived), and imports cannot add to an
  archived product. A variant with an active reservation cannot be archived.
- **Search and paging:** `GET /v1/products?q=` matches names and SKUs (case-insensitive, substring). Lists are newest first with
  an opaque `cursor` and `limit` (1 to 100, default 50); `nextCursor` is `null` on the last page. Each product carries its
  variants with **stock totals summed across locations**.

### Stock: the ledger

Stock is **never edited directly**. Every change appends a row to an append-only ledger (`GET /v1/inventory/movements`), and the
current level of each variant at each location is the running total of its ledger. The two always agree: a randomised test
replays the ledger through the pure rules and checks it lands on the stored level.

Each level has these numbers:

- `onHand`: sellable units physically on the shelf.
- `reserved`: promised to open reservations.
- `available = onHand - reserved`. It can never be negative: `0 <= reserved <= onHand`, enforced by the database itself.
- `damaged`: physically here but unsellable. It is **not part of `onHand`**, so damaged units can never be sold or reserved.

| Movement type | Effect                                                             | Caused by                                       |
| ------------- | ------------------------------------------------------------------ | ----------------------------------------------- |
| `RECEIVE`     | `onHand` up                                                        | `POST /v1/inventory/receive`, CSV opening stock |
| `ADJUSTMENT`  | `onHand` up or down (needs a reason; cannot cut into reserved)     | `POST /v1/inventory/adjust`                     |
| `RESERVE`     | `reserved` up                                                      | `POST /v1/reservations`                         |
| `RELEASE`     | `reserved` down                                                    | `POST /v1/reservations/{id}/release`            |
| `SHIP`        | `onHand` and `reserved` both down                                  | `POST /v1/reservations/{id}/fulfil`             |
| `DAMAGE`      | `onHand` down, `damaged` up (needs a reason; only available units) | `POST /v1/inventory/damage`                     |
| `WRITE_OFF`   | `damaged` down (needs a reason; never more than are damaged)       | `POST /v1/inventory/write-off`                  |
| `RETURN`      | `onHand` up (resaleable) or `damaged` up (damaged)                 | `POST /v1/inventory/return`                     |

Ledger rows come back newest first in the order they were applied (never re-sort by timestamp: rows in the same millisecond tie). Each carries the `reason`, an optional
`referenceType`/`referenceId` (for example an order, in a later phase), and who did it. Quantities are whole numbers from 1 to
1,000,000 per request; a level is capped at 1,000,000,000.

**Locations.** Stock is held per location. The first time stock is used with no location named, the business's oldest active
location becomes its default, or "Main warehouse" is created if it has none; requests that name no `locationId` use the default.
Listing locations only reads. Concurrent first uses cannot create duplicates. Create more with `POST /v1/locations`. A location holding or promising stock
cannot be archived, and neither can the default one. Archiving races safely with stock changes: a change in flight either
commits first (and archiving is then refused) or finds the location archived.

**Overselling is impossible, even under load.** A reservation succeeds only if `onHand - reserved >= quantity`, decided inside
the single database statement that updates the level, so 50 simultaneous requests for the last 10 units grant exactly 10 and
refuse 40 with `409 insufficient_stock` (`"Only 0 available, 1 requested"`). A refused request changes nothing and writes no
ledger row. Likewise an adjustment cannot take `onHand` below `reserved`.

**Reservations** hold stock for something (an order, a basket). They resolve exactly once: `release` gives the units back,
`fulfil` ships them. A second attempt, or a simultaneous one, gets `409` (`"Reservation is already RELEASED"`); an unknown or
another business's id is `404`.

**Idempotency.** Send an `idempotencyKey` (8 to 100 characters of letters, digits and `. _ : -`) with `receive`, `adjust`,
`damage`, `write-off` or `POST /v1/reservations`; it is **required** for `POST /v1/inventory/return`, because a return processed
twice must add the units once. Retrying the same request with the same key changes nothing and returns the original result, even if
the retries race. Reusing a key for a _different_ request (another variant, quantity or kind) is `409`, never silently ignored.
Keys are per business.

**Low stock.** `GET /v1/inventory/low-stock` lists active variants with a `reorderPoint` above 0 whose available stock, summed over
all locations, is at or below it (including variants with no stock at all), thinnest first. `GET /v1/inventory?lowStock=true`
applies the same test to each location separately.

### Importing a catalog from CSV

Check first: `POST /v1/imports/products/validate` takes the same body and returns what the import _would_ do without changing
anything: `willCreate`, `willUpdate`, `validRows`, `errorCount` and the first 100 `errors: [{ row, message }]` (the file's own
problems plus conflicts with existing data: an archived product, a SKU that belongs to another product, a different unit, an
archived supplier or location). A file that cannot be read at all comes back with `fatal` set. The web app always shows this
before it lets a person start the import. The apply step re-checks everything, since data can change in between.

`POST /v1/imports/products` with `{ "csv": "..." }` returns **202 Accepted** at once with an import job; a separate worker
process does the work. Poll `GET /v1/imports/{id}` until `status` is `COMPLETED` or `FAILED`. `GET /v1/imports` lists the 20 most
recent.

Columns (a header row is required; names are case-insensitive; **unknown columns are rejected** so a typo cannot silently drop
data):

| Column                   | Required | Notes                                                                                        |
| ------------------------ | :------: | -------------------------------------------------------------------------------------------- |
| `product_name`           |   yes    | Rows with the same name (any case) are variants of one product.                              |
| `sku`                    |   yes    | Normalised like everywhere else. Repeated within the file is an error.                       |
| `price`                  |   yes    | BDT with at most 2 decimals, for example `1250` or `1250.50`. Stored as paisa.               |
| `category`               |    no    | Created if missing.                                                                          |
| `unit`                   |    no    | Default `pcs`. Rows of one product must agree on unit and category.                          |
| `variant_name`           |    no    | For example `Red / M`. Defaults to `colour / size` when those are given.                     |
| `size`, `colour`         |    no    | Stored as variant attributes; `color` is accepted as a spelling of `colour`.                 |
| `supplier`               |    no    | Created if missing; an archived supplier is a row error.                                     |
| `cost`                   |    no    | Same format as `price`.                                                                      |
| `reorder_point`          |    no    | Whole number, default 0.                                                                     |
| `barcode`, `description` |    no    |                                                                                              |
| `opening_stock`          |    no    | Whole number. Applied only when the variant is **new**, so re-importing never double-counts. |
| `location`               |    no    | Where opening stock goes (created if missing); default location otherwise.                   |

```csv
product_name,sku,price,category,unit,variant_name,cost,reorder_point,opening_stock,location
Cotton T-Shirt,TEE-R-M,1250.50,Shirts,pcs,Red / M,800,5,20,
Cotton T-Shirt,TEE-R-L,1250.50,Shirts,pcs,Red / L,800,5,10,Dhaka outlet
Basmati Rice,RICE-5KG,650,Grocery,kg,5 kg bag,,,40,
```

**Behaviour.**

- Existing SKUs are **updated** (price, cost, name, barcode, reorder point), existing products matched by name keep their unit,
  new ones are created. A SKU that belongs to a different product, or a unit that differs from an existing product, is a row
  error.
- Each row is its own transaction: **one bad row never loses the good ones.** Problems come back as `errors: [{ row, message }]`
  (line numbers, header is line 1; at most the first 100), with `created`, `updated`, `failed` counts and `totalRows`.
- A malformed file (missing required column, unknown column, unterminated quote, no rows) sets `status: FAILED` with one error
  and imports nothing.
- Limits: 2 MB and 5,000 rows per file. Larger files must be split. A business may have **3 imports waiting or running at once**
  (a fourth is `429 rate_limited`), so one tenant's backlog cannot starve the others.
- The raw CSV is deleted from the database when processing ends, and **only ids ever go on the queue**, never file content.
- Safe to retry and to crash: a job is claimed by exactly one worker. If the worker dies or fails, the queue redelivers the job
  (up to 3 attempts with backoff) and the next attempt takes over immediately; rows are idempotent and opening stock carries a
  per-row key, so nothing is counted twice. After the last attempt the import is marked `FAILED` and its CSV deleted. After a
  resume, rows created by the earlier attempt are reported as `updated`, so the counts of a recovered import are approximate.
- If the queue is unreachable you get `503` and the job is marked `FAILED`, with no CSV left behind.

### Exporting to CSV

`GET /v1/exports/products` (`catalog:read`) returns `{ filename, rowCount, csv }`: the active catalog in **exactly the import
columns**, so a file can be exported, edited and imported back (`opening_stock` and `location` are left empty on purpose: opening
stock only applies to new variants, so a re-import never double-counts). Prices are decimal strings (`1250.50`) produced from
whole paisa. `GET /v1/exports/stock` (`inventory:read`) returns one row per variant and location with `on_hand`, `reserved`,
`damaged`, `available` and `reorder_point`. Cells that would be run as a formula by a spreadsheet (starting with `=`, `+`, `-`
or `@`) get a leading apostrophe. Archived products and variants are left out of the catalog export. Each export is audited
(`export.products`, `export.stock`) and only ever contains the caller's own business (capped at 50,000 rows).

### Request bodies

JSON bodies are limited to **100 KB** on every route. The one exception is `POST /v1/imports/products` (up to 3 MB, for the 2 MB
CSV), and only for callers who send a bearer token: anonymous requests there get `401` before the body is read. A body that
is too large is `413`, and one that is not valid JSON is `400`, both as problem details that never echo the body back.

## Rate limiting and lockout

Limits are per client IP and apply to every route unless stated. Exceeding one returns `429 rate_limited` with a
`Retry-After` header. Set `TRUST_PROXY` to the exact number of reverse-proxy hops in production, or every client shares the
proxy's address.

| Scope                                                                                         | Limit                                                      |
| --------------------------------------------------------------------------------------------- | ---------------------------------------------------------- |
| Default, all routes                                                                           | 120 per minute                                             |
| `register`, `login`, `accept-invitation`, `verify-email`, `forgot-password`, `reset-password` | 10 per minute                                              |
| `refresh`                                                                                     | 30 per minute                                              |
| `resend-verification`                                                                         | 3 per minute                                               |
| Failed sign-ins for one account from one IP                                                   | 5 per 15 minutes, then locked for the rest of the window   |
| Failed sign-ins for one account from all IPs together                                         | 50 per 15 minutes, then the account is locked for everyone |
| Reset emails per address                                                                      | 3 per hour (extra requests answer 200 but send nothing)    |

The per-account lockout is keyed by account **and** IP, so a stranger's bad guesses cannot lock you out from your own
network. The IP limiter is in memory per API instance and the lockout counters live in Redis (they fail open if Redis is down).
Use a shared store for the IP limiter before running more than one replica.

## Email

Verification, password reset, password-changed notices and invitations are sent by a pluggable mailer chosen with
`MAIL_PROVIDER`. A mail outage never fails the request that triggered it: the failure is logged (kind and a hash of the
recipient, never the body or token) and the user can use "resend" or "forgot password" again.

| Provider  | Use                  | What it does                                                                                                                                                                                                                                                 |
| --------- | -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `console` | Local development    | Prints the email, **including its one-time link**, to the terminal running the API (plain text, not through the structured logger, whose redaction would mask the link). Needs no credentials. The server refuses to start with this provider in production. |
| `smtp`    | Local and production | Sends through any SMTP server using the `SMTP_*` variables.                                                                                                                                                                                                  |

### Local development without credentials

Nothing to configure: the default `MAIL_PROVIDER=console` prints each email in the terminal running the API. Copy the link
(or just the `token=` value) into `POST /v1/auth/verify-email` or `reset-password`.

To see real, rendered emails and exercise the SMTP code path with no external account, run the local Mailpit inbox
(it catches everything and delivers nothing outside your machine):

```bash
pnpm services:mail          # starts Mailpit; inbox UI at http://localhost:8025
```

then set, in `.env`, and restart the API:

```
MAIL_PROVIDER=smtp
SMTP_HOST=127.0.0.1
SMTP_PORT=1025
```

Use `127.0.0.1`, not `localhost`: the mail library resolves host names with its own DNS lookup, which does not read `/etc/hosts` and can time out on some networks.

### Production

Pick an email provider that offers SMTP (Amazon SES, Postmark, SendGrid, Mailgun, Resend and similar), verify your sending
domain with them (SPF, DKIM and DMARC DNS records, so mail is not marked as spam), create SMTP credentials, and set:

| Variable                     | Meaning                                                                                             |
| ---------------------------- | --------------------------------------------------------------------------------------------------- |
| `MAIL_PROVIDER`              | `smtp`                                                                                              |
| `MAIL_FROM`                  | Sender, for example `OrderLoop <no-reply@yourdomain.com>`. Must be an address your provider allows. |
| `SMTP_HOST`                  | The provider's SMTP host name (from their dashboard)                                                |
| `SMTP_PORT`                  | `587` (STARTTLS, the usual choice) or `465` (implicit TLS)                                          |
| `SMTP_SECURE`                | `true` for port 465, otherwise `false`                                                              |
| `SMTP_USER`, `SMTP_PASSWORD` | The provider's SMTP credentials. Set both or neither.                                               |

Store the credentials in your secret manager or deployment environment, never in the repository. The API validates this
configuration at start-up and exits with a clear message if it is incomplete.

Links in emails point at the first entry of `WEB_ORIGINS` (`/verify-email`, `/reset-password`, `/accept-invitation`, each
with `?token=`). Those pages arrive with the web app in Phase 6; until then use the token directly against the API.
To use an HTTP email API instead of SMTP, add a class extending `Mailer` (`apps/api/src/mail/mailer.ts`) and select it in
`mail.module.ts`.

## Logging

One JSON object per line on stdout (`level`, `time`, `service`, plus fields). Each request produces one
`request completed` line with `requestId`, `method`, `path`, `status`, `durationMs`, `ip`, and `userId`/`tenantId` when
authenticated. Level is `info` for success, `warn` for 4xx, `error` for 5xx; health checks log at `debug`. `LOG_LEVEL`
selects the threshold.

Redaction is layered, and tested end to end (`apps/api/test/logging.e2e.test.ts` runs every credential-bearing flow and
asserts that no password, access token, refresh token, verification, reset or invitation token, password hash, or email
address appears in the output):

1. Request and response **bodies, headers, user agents and query strings are never logged**.
2. Structured fields named like credentials (`password`, `token`, `accessToken`, `refreshToken`, `authorization`, `cookie`,
   `passwordHash`, and so on, several levels deep) are replaced with `[REDACTED]`.
3. Free text, such as error messages and stacks that might echo a secret, passes through a scrubber that masks JWTs,
   argon2 hashes, bearer credentials, invitation tokens, 256-bit tokens and credentials inside connection URLs.

The one deliberate exception is `MAIL_PROVIDER=console`, which prints the email to the terminal on purpose (not into the JSON log) and is blocked in production.

## Environment variables

Validated when the process starts; a bad or missing value stops it with a message listing every problem (values are not
echoed). The full annotated list is `.env.example`.

| Variable                                             | Required   | Notes                                                                                                                                         |
| ---------------------------------------------------- | ---------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `DATABASE_URL`                                       | yes        | Runtime role `app_user`. See database.md.                                                                                                     |
| `REDIS_URL`                                          | yes        |                                                                                                                                               |
| `JWT_PRIVATE_KEY`, `JWT_PUBLIC_KEY`                  | production | Both or neither. Dev generates an ephemeral key (restart signs everyone out).                                                                 |
| `MAIL_PROVIDER`, `MAIL_FROM`, `SMTP_*`               | no (dev)   | `smtp` requires `SMTP_HOST`; `console` is refused in production.                                                                              |
| `WEB_ORIGINS`                                        | no         | Allowed browser origins (CORS and cookie refresh). Default `http://localhost:3000`.                                                           |
| `TRUST_PROXY`                                        | no         | Reverse-proxy hops, 0 to 5. Default 0.                                                                                                        |
| `ACCESS_TOKEN_TTL_SECONDS`, `REFRESH_TOKEN_TTL_DAYS` | no         | Defaults 900 and 30.                                                                                                                          |
| `LOG_LEVEL`                                          | no         | Default `info`.                                                                                                                               |
| `NODE_ENV`                                           | **yes**    | `development`, `test` or `production`. No default, so a deploy that forgets it fails to start instead of running with development safeguards. |
| `API_PORT`, `RATE_LIMIT_ENABLED`                     | no         | `RATE_LIMIT_ENABLED=false` is for automated tests only.                                                                                       |

## Trying it

```bash
# start services and the API (see README)
curl -s -X POST localhost:4000/v1/auth/register -H 'content-type: application/json' \
  -d '{"email":"you@example.com","password":"a long passphrase","name":"You","tenantName":"My Shop"}'
# the verification email is printed in the API log (console provider); use its token:
curl -s -X POST localhost:4000/v1/auth/verify-email -H 'content-type: application/json' -d '{"token":"<token>"}'
# or sign in as the seeded demo owner (pnpm db:seed; local development only):
curl -s -X POST localhost:4000/v1/auth/login -H 'content-type: application/json' \
  -d '{"email":"owner@demo.orderloop.test","password":"demo-password-change-me"}'
```

## Tests

`pnpm test` runs unit tests (no services). `apps/api/test/user-journey.e2e.test.ts` is the checkpoint test: it walks a native-app user and a browser user through register, protected access, refresh and logout over real HTTP with plain `fetch`. `pnpm test:integration` runs the API against real PostgreSQL and Redis in an
isolated `orderloop_test` database, covering: valid and invalid sign-in; account lockout; token rotation, reuse detection and
expiry; session revocation by logout, password reset, member removal and account disabling; unauthorised and forged tokens;
email verification and password reset including concurrency and purpose confusion; rate limits on every sensitive endpoint;
log redaction; start-up environment validation against the built server; and the tenant-isolation suite.

## Security notes and accepted limits

- **Emails contain no text a stranger chose.** Anyone can register an account for someone else's address, so verification
  and reset emails never include the account name, and display names reject line breaks and invisible or bidirectional
  control characters. The verification email says to ignore it if the recipient did not sign up.
- **Registration reveals whether an email is taken** (`409 conflict`), limited to 10 requests per minute per IP. Hiding it
  would mean not returning a session at sign-up (it would have to arrive by email), which is a product decision; it is
  accepted for now. Sign-in, forgot-password and every email link answer uniformly.
- **Pre-registration.** Someone can create an unverified account for another person's address and know its password. If that
  person later confirms the address from the emailed link instead of ignoring it, the account becomes verified while the
  other party still knows the password. Mitigations in place: the email says to ignore it if you did not sign up; a
  password reset (the recovery path) ends every session and replaces the password; inviting people requires a verified
  address. Not yet in place: expiring unverified accounts, or forcing a password change at first verification.
- **Mail provider errors** are logged with a hash of the recipient and with email addresses masked in the provider's message.
- **The per-account lockout** is keyed by account and IP plus a high account-wide threshold, so a stranger cannot cheaply lock
  you out. **Reset emails** are limited per address; the limit does not block your own link (see forgot-password).
- Seed data refuses to run in production or against a non-local database, with no override flag.
