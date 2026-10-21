# Implementation Plan

Status: **PROPOSED — awaiting approval.** Companion to [architecture.md](architecture.md).
Date: 2026-10-15.

## 1. Repository state

Greenfield: only `README.md` and one commit on `main`; remote `origin` is `Shahriar-shaown/OrderLoop`. No code or tooling exists. Local machine has Node 22.19, npm 10.9, Postgres 16.15; it lacks pnpm, Docker, and Redis.

## 2. Proposed directory structure

```
OrderLoop/
├─ apps/
│  ├─ api/            NestJS REST API
│  ├─ worker/         BullMQ processors (NestJS standalone)
│  ├─ web/            Next.js dashboard
│  └─ mobile/         Expo (React Native) app
├─ packages/
│  ├─ contracts/      Zod schemas, types, enums, error codes
│  ├─ api-client/     Generated typed client
│  ├─ db/             Prisma schema, migrations, tenant extension, seed
│  ├─ domain/         Pure business rules (order FSM, COD, inventory, money, phone)
│  ├─ courier-sdk/    CourierAdapter + mock/real adapters
│  └─ config/         tsconfig / eslint / prettier presets, env helpers
├─ infra/
│  ├─ docker-compose.yml   postgres + redis (+ mailpit)
│  └─ ci/                  workflow helpers
├─ .github/workflows/ci.yml
├─ docs/
│  ├─ architecture.md
│  └─ implementation-plan.md
├─ .env.example
├─ .nvmrc  (22)
├─ package.json  pnpm-workspace.yaml  turbo.json  tsconfig.base.json
└─ README.md
```

Conventions: TypeScript strict; ESM for packages where tooling allows; Conventional Commits; short-lived feature branches merged by PR; one phase = one PR series, each PR green on CI.

## 3. Phases and acceptance criteria

Each phase ends with a demo, a green CI, and your sign-off before the next begins.

### Phase 0 — Foundation (FIRST MILESTONE)

Scope: pnpm workspace, Turborepo, shared TS/ESLint/Prettier config, empty-but-running skeletons for `api` (`/health/live`, `/health/ready`), `worker` (connects to Redis, logs ready), `web` (landing page), `mobile` (blank Expo Router screen), docker-compose for Postgres + Redis, CI workflow, version-drift check, `.env.example` with zod env validation.
Acceptance:

- Fresh clone then `pnpm install` then `pnpm dev` starts all four apps with no manual steps beyond `.env` copy and `docker compose up`.
- `pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm build` all pass locally and in CI.
- `GET /health/ready` reports Postgres and Redis status.
- Mobile app opens in iOS Simulator (and Android emulator if available) and `expo-doctor` is clean.
- Dependency-boundary lint rule fails when `web` imports `db` (proved by a test fixture).
- Exact-pin check passes (React 19.2.3 across all workspaces).

### Phase 1 — Identity and tenancy (API)

Scope: Prisma setup, `User`, `Tenant`, `Membership`, `Session`, `AuditLog`; register tenant+owner, login, refresh with rotation and reuse detection, logout, switch tenant, invite member, roles/permissions; tenant-scoped Prisma extension; RLS migrations; `app_user` and `app_migrator` roles; throttling.
Acceptance:

- Unit and e2e tests cover token rotation, replay revoking the family, expired and revoked tokens, and role checks.
- **Tenant isolation suite** passes: cross-tenant reads, writes, and lists fail for every tenant table; unset tenant setting returns zero rows; CI fails if a tenant table lacks RLS.
- Benchmark documented: p95 overhead of the per-request tenant transaction under 15 ms locally.
- OpenAPI spec generated and `api-client` builds from it.

### Phase 2 — Catalog and inventory

Scope: products, variants, SKUs, units, categories, stock locations, stock movement ledger, reservations, adjustments, low-stock query, CSV import (worker job).
Acceptance:

- Concurrency test: 50 parallel reservations against 10 units yield exactly 10 successes, never negative stock.
- Ledger replay equals materialised on-hand for a randomised property test.
- Tenant isolation suite extended and green.

### Phase 3 — Customers and orders

Scope: customers (dedupe by normalised phone), addresses (BD hierarchy), orders and line items, per-tenant order numbers, order state machine, order events, repeat-customer detection, manual and bulk order entry, idempotent create.
Acceptance:

- Property tests: illegal transitions rejected; totals (subtotal, discount, delivery charge, COD amount) always equal the sum of lines in paisa.
- Duplicate submit with the same `Idempotency-Key` creates exactly one order.
- Phone normalisation handles `01XXXXXXXXX`, `+8801…`, `8801…`, and Bangla digits.
- Stock is reserved on confirm, released on cancel, and shipped on handover.

### Phase 4 — Courier integration (mock first)

Scope: `CourierAdapter` interface; mock adapter with configurable outcomes; shipment creation, tracking-status sync (poll and webhook inbox), status normalisation table; encrypted per-tenant credentials storage; real adapters (Steadfast, Pathao, then RedX/Paperfly) behind feature flags.
Acceptance:

- Mock adapter drives a full order life cycle (booked → in transit → delivered/returned) through worker jobs end to end.
- Webhook replay and out-of-order events do not corrupt order status (tests).
- Credentials encrypted at rest and never present in logs or API responses (test asserts).
- Each real adapter ships with recorded-fixture contract tests; live verification is gated on credentials (see §4).

### Phase 5 — COD reconciliation and settlements

Scope: COD ledger, expected vs collected, courier fees and return fees, settlement import (CSV/API), auto-match to orders, mismatch queue, partial delivery handling, payout reports.
Acceptance:

- Golden-file tests of settlement scenarios (full, partial, return, fee dispute) reconcile to the paisa.
- Every adjustment is a new ledger entry; no ledger row is ever updated or deleted (DB trigger test).
- Mismatches appear in a queue with the reason; resolving one writes an audited entry.

### Phase 6 — Web dashboard

Scope: auth screens, tenant switcher, product/inventory, order list and detail, create order, shipment actions, COD and settlement views, team and roles; `bn`/`en` i18n; Tailwind and shadcn.
Acceptance:

- Playwright E2E: sign up, add product, create order, book mock courier, see delivered, see reconciled.
- Lighthouse performance 90+ and accessibility 95+ on core pages.
- No direct DB or `db` package import in `web` (lint-enforced).

### Phase 7 — Mobile app (iOS and Android)

Scope: login with secure storage, order capture, order list and status, scan or lookup, push notifications, offline queue with idempotent sync.
Acceptance:

- Runs in iOS Simulator and Android emulator; order created offline syncs exactly once on reconnect.
- Usable on a low-end Android profile (cold start under 4 s on a mid-range test device).
- EAS internal builds produced (needs accounts, §4).

### Phase 8 — Analytics and reporting

Scope: sales, profit (with COGS), delivery success rate by courier and area, return rate, COD outstanding, repeat-customer cohorts; materialised views refreshed by worker; CSV export.
Acceptance: numbers match a hand-computed seed dataset to the paisa; dashboards render under 1 s for 100k orders (seeded benchmark).

### Phase 9 — Channels (Facebook/Instagram) and notifications

Scope: webhook intake, conversation-to-order helper, SMS/WhatsApp order confirmations through a provider interface.
Acceptance: mock-webhook flow creates draft orders; real flow verified only after app review and credentials (§4).

### Phase 10 — Hardening and launch

Scope: backups and restore drill, OpenTelemetry, Sentry, load test, security review (OWASP pass), rate limits, data-retention and privacy policy, staging and production deploys, runbooks.
Acceptance: restore drill documented and tested; load test target met; security review findings resolved; zero high-severity open issues.

## 4. Credentials: what needs third-party access

**Can be built and fully tested with no external credentials:** monorepo and CI, auth, tenancy and RLS, catalog and inventory, customers and orders, order state machine, courier **mock** adapter and all worker plumbing, COD ledger and reconciliation logic (with CSV fixtures), web dashboard, mobile app against the local API (simulator/emulator), analytics, i18n, import/export, webhook handling against simulated payloads.

| Needs external access                         | Phase       | What is required                                                                                             |
| --------------------------------------------- | ----------- | ------------------------------------------------------------------------------------------------------------ |
| Steadfast, Pathao, RedX, Paperfly live APIs   | 4           | Merchant account plus API keys or sandbox. Without them, only mock and fixture tests.                        |
| SMS provider (e.g. SSL Wireless, BulkSMSBD)   | 1 (OTP) / 9 | Account, sender ID approval. Dev uses a console sender.                                                      |
| Meta app (Facebook/Instagram)                 | 9           | Meta developer app, business verification, app review, test page.                                            |
| Expo EAS and Apple/Google developer accounts  | 7           | For device builds, TestFlight, Play internal track, push credentials. Simulator and emulator runs need none. |
| Email provider (Resend/SES/SMTP)              | 1           | Dev uses Mailpit locally.                                                                                    |
| Hosting (API, DB, Redis, web) and domain      | 10          | Cloud accounts. Local dev needs none.                                                                        |
| Error and monitoring (Sentry etc.)            | 10          | Optional DSN.                                                                                                |
| Billing for the SaaS (bKash/Nagad/SSLCommerz) | later       | Merchant accounts. Out of scope for the first ten phases.                                                    |

## 5. Exact commands

Prerequisites (one time):

```bash
nvm use 22                       # or install Node 22.19+
corepack enable
corepack prepare pnpm@11.28.6 --activate
```

Local services (Docker, per decision D4; the Homebrew Postgres should be stopped to avoid port 5432 clashes, or compose maps 5433):

```bash
docker compose -f infra/docker-compose.yml up -d     # postgres:16, redis:7, mailpit
```

Install and set up:

```bash
pnpm install
cp .env.example .env
pnpm db:generate            # prisma generate
pnpm db:migrate             # prisma migrate dev (applies migrations)
pnpm db:seed                # demo tenants and data
```

Run:

```bash
pnpm dev                    # turbo: api, worker, web, mobile bundler
pnpm --filter @orderloop/api dev       # API only  (http://localhost:4000)
pnpm --filter @orderloop/worker dev    # worker only
pnpm --filter @orderloop/web dev       # web only  (http://localhost:3000)
pnpm --filter @orderloop/mobile start  # Expo dev server (press i for iOS simulator)
```

Quality and tests:

```bash
pnpm lint
pnpm typecheck
pnpm test                   # unit tests (vitest/jest) across workspaces
pnpm test:e2e               # API e2e (supertest, needs Postgres+Redis) + Playwright
pnpm test:isolation         # tenant isolation suite only
pnpm check:versions         # exact-pin drift check
pnpm --filter @orderloop/mobile exec expo-doctor
```

Build:

```bash
pnpm build                  # turbo build: contracts, domain, db, api, worker, web
pnpm --filter @orderloop/web build
pnpm --filter @orderloop/api build
pnpm --filter @orderloop/mobile exec eas build --platform all --profile preview   # needs EAS account
```

Scaffolding commands used in Phase 0 (for transparency; run only after approval):

```bash
pnpm dlx create-next-app@16.4 apps/web --ts --app --tailwind --eslint --use-pnpm --no-src-dir
npx create-expo-app@latest apps/mobile --template default@sdk-57   # then: npx expo install --fix
pnpm dlx @nestjs/cli@12 new apps/api --package-manager pnpm --skip-git
```

## 6. Decisions requiring approval

| ID  | Question                                                                                                   | Recommendation                                                                                                                                               |
| --- | ---------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| D1  | **Naming:** product and npm scope.                                                                         | **DECIDED: OrderLoop, scope `@orderloop/*`.**                                                                                                                |
| D2  | **React pinned to 19.2.3** (Expo SDK 57's bundled version) for web too, not the newer 19.3.1.              | Approve.                                                                                                                                                     |
| D3  | **Prisma 7.10.0 stable** and **TypeScript 6.0.3**, instead of the `latest` tags (Prisma 8 RC, TS 7).       | Approve.                                                                                                                                                     |
| D4  | **Local services.**                                                                                        | **DECIDED: Docker.** Docker is not installed on this machine yet; Docker Desktop must be installed before M0 verification. Homebrew Redis option is dropped. |
| D5  | **pnpm 11.28.x** vs the newest pnpm 12.11.                                                                 | pnpm 11.x.                                                                                                                                                   |
| D6  | **Multitenancy model:** shared schema with RLS, rather than schema-per-tenant or DB-per-tenant.            | Shared schema with RLS.                                                                                                                                      |
| D7  | **Web-first order:** Phases 1–6 deliver API plus web; mobile starts in Phase 7.                            | Approve. Mobile in parallel would slow API stabilisation.                                                                                                    |
| D8  | **Money in integer paisa**, BDT only at first (multi-currency out of scope).                               | Approve.                                                                                                                                                     |
| D9  | **Languages:** Bangla and English from the start.                                                          | Approve.                                                                                                                                                     |
| D10 | **Git workflow:** feature branches and PRs into `main` (remote is GitHub), Conventional Commits.           | Approve; I will not push or open PRs unless you ask.                                                                                                         |
| D11 | Will you obtain courier sandbox keys, SMS provider, Meta app, and Apple/Google accounts, and roughly when? | Start applications for Meta review and Apple/Google accounts early; they have long lead times.                                                               |

## 7. First implementation milestone

**Milestone M0 = Phase 0 (Foundation).** Estimated as a single PR series: workspace and tooling, four app skeletons, docker-compose, CI, boundary lint, version check. It contains no business logic, and its definition of done is the Phase 0 acceptance list above.

## 8. Foundation status (Phase 0 / "Milestone 1", 2026-10-15)

Branches: `feat/m0-foundation` then `feat/m1-dev-foundation`.

Verified locally: `pnpm install`; `pnpm check` (lint, typecheck, test, build for all 6 workspaces, plus `check:versions`, `check:boundaries`) passes; the same `check` passes under Bun in a scratch copy; `expo-doctor` 21/21; `pnpm dev` starts API, worker, web and Expo; API `/health/live` is 200; `/health/ready` is 503 with Redis reported down and **PostgreSQL reported up against a real PostgreSQL 16 on port 5433**; the web development page renders the live health result; Metro serves an iOS dev bundle containing the mobile home screen.

**Verified with Docker Desktop 4.95 (2026-10-15):** `pnpm services:up` brings Postgres 16 (5433) and Redis 7 (6379) to healthy; `/health/ready` returns 200 `{"status":"ok","checks":{"postgres":"up","redis":"up"}}`; the web page shows both up; the worker logs `ready, listening on queue "system"`.

**Verified on the Android emulator (Medium Phone, API 37, 2026-10-15):** Expo Go installed, Metro bundled 1507 modules, the development home screen rendered, and **Check API health** returned Status ok, PostgreSQL up, Redis up (using `adb reverse` for ports 4000 and 8081).

**Not verified (environment gaps):**

- iOS Simulator launch: Xcode cannot be installed on the development machine. iOS is covered by the Metro iOS bundle build and (when available) Expo Go on a physical iPhone; Android emulator is the verified mobile runtime. _(Note, 2026-10-21: iOS was later verified on an iPhone 17 simulator with a native development build; see "How it was verified" in [mobile.md](mobile.md). The statement above is kept as written at the time.)_
- GitHub Actions workflow has not run (nothing pushed).

Notes: pnpm 11 manages `overrides`/`allowBuilds` in `pnpm-workspace.yaml` (mirrored in `package.json` `overrides` for Bun); `packages/db` and `courier-sdk` are created in the phases that need them; `@orderloop/contracts` has a browser-safe root entry and a Node-only `@orderloop/contracts/server` entry (found when the mobile bundle failed on `node:fs`).

## 9. Phase 1 status: identity and tenancy (2026-10-15)

Branch `feat/phase1-identity-tenancy`. Design notes and deviations are in [architecture.md](architecture.md) section 12.

**Delivered:** Prisma 7.10 schema and migrations (users, tenants, memberships, sessions, refresh tokens, invitations, audit log); `app_migrator`/`app_user` roles; forced row-level security; register, login, refresh with rotation and reuse detection, logout, switch tenant, invite and accept, role changes, member removal, audit log, `/v1/me`, `/v1/tenant`; per-IP rate limiting and per-account lockout; route registry, typed client, generated OpenAPI.

**Acceptance criteria:**

| Criterion                                                                                                                                    | Result                                                                                                                                                                                    |
| -------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Tests cover token rotation, replay revoking the family, expired and revoked tokens, role checks                                              | Met: `auth.e2e` and `members.e2e` (including concurrent exchange and concurrent demotion)                                                                                                 |
| Tenant-isolation suite: cross-tenant read, write and list fail for every tenant table; unset context returns zero rows; CI fails without RLS | Met: `tenant-isolation.e2e` (database level as `app_user`, API level, pooled-connection stress, schema introspection)                                                                     |
| Per-request tenant transaction p95 overhead under 15 ms                                                                                      | Met: about 1.8 ms (1 query) and 2.4 ms (3 queries) on local Docker. Re-measure on production-like infrastructure.                                                                         |
| OpenAPI spec generated and `api-client` builds from it                                                                                       | Met, with a variation: both derive from the route registry rather than the client being generated from the spec file; a test pins `docs/openapi.json` and a live-client test exercises it |

**Review:** an independent security review found no critical or high issues; its medium and low findings are handled as listed in architecture.md section 12.

**Verified:** `pnpm check` (32 tasks) passes; 25 API unit tests and 71 integration tests pass against real PostgreSQL 16 and Redis 7; a live run against the dev server registered a tenant and returned `/health/ready` ok.

**Known limits (not blockers for Phase 2):** no email delivery (invitation links are logged in development); no password reset or email verification yet; per-instance in-memory IP rate limiting (shared store needed for multiple replicas); registration reveals taken emails; no refresh grace window; the web and mobile apps do not use the auth API yet (Phases 6 and 7); iOS runtime is still unverified (no Xcode). _(Superseded: iOS was verified later, see the note under Phase 1 and [mobile.md](mobile.md).)_

## 10. Milestone 2 status: database and authentication complete (2026-10-15)

Branch `feat/m2-auth-completion`, on top of Phase 1. Behaviour is documented in [api.md](api.md) and [database.md](database.md).

**Added on top of Phase 1:** email verification and password reset (one-time hashed tokens, every session revoked on reset, anti-enumeration, per-address send limit); a pluggable mailer with console (development), SMTP (Mailpit locally, any provider in production) and in-memory (tests) implementations; structured JSON logging with layered redaction and a request id on every request; stricter start-up validation (mail, log level, production rules); a development-only seed script; inviting now requires a verified email, and accepting an invitation verifies the invited address.

**Fixed:** Phase 1 migrations failed under `prisma migrate dev` (Prisma's shadow database replays them before `_prisma_migrations` exists); the `REVOKE` is now conditional. Local databases were rebuilt from scratch to prove a fresh `db:init` works.

**Verified:** SMTP delivery against a real Mailpit (email arrived with correct sender and recipient, token redeemed once, reuse rejected, and the API log contained neither the token nor the password). Unit and integration suites pass; the full list is in the report that accompanied this milestone.

**Independent review of the new flows:** no critical or high findings. Fixed from it: a timing difference in forgot-password (all differing work now runs after the response); resets could be blocked by someone else's requests (earlier links no longer expire when a new one is issued); account names no longer appear in emails and are validated; email addresses are masked in logged provider errors; unauthenticated reset requests no longer write into tenants' audit logs; `NODE_ENV` is required (no default) and the seed script has no remote override. Also found and fixed while verifying: the console mailer printed `[REDACTED]` instead of the link, because it went through the redacting logger (it now writes to the terminal and was tested end to end). Accepted and documented in api.md: registration reveals whether an email is taken, and pre-registration of an unverified account.

**Not done / known limits:** the pages the email links point to (`/verify-email`, `/reset-password`, `/accept-invitation`) arrive with the web app in Phase 6; no change-password-while-signed-in endpoint; no production email provider has been exercised (no credentials); registration still reveals whether an email is taken; the IP rate limiter is per instance.

## 11. Phase 2 status: catalog and inventory (2026-10-17)

Branch `feat/phase2-catalog-inventory`. Behaviour is documented in [api.md](api.md) ("Catalog, stock and imports") and
[database.md](database.md); design notes and the review log are in [architecture.md](architecture.md) section 13.

**Delivered:** categories, products with variants (SKU, integer-paisa prices, units), stock locations, stock levels backed by an
append-only ledger, receive and adjust (with reasons and idempotency keys), reservations (hold, release, fulfil), low-stock
alerts, the movements ledger, CSV catalog import processed by the BullMQ worker, role permissions (`catalog:*`, `inventory:*`),
a fictional demo catalog in the seed, and the shared `packages/catalog` that holds the stock rules for both API and worker.

**Acceptance criteria:**

| Criterion                                                                                    | Result                                                                                                                                                                                                                          |
| -------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 50 parallel reservations against 10 units give exactly 10 successes and never negative stock | Met: `inventory.e2e` ACCEPTANCE test (10 granted, 40 `409 insufficient_stock`, level 10/10/0, no 5xx). Repeated 15 times in a row with no failure.                                                                              |
| Ledger replay equals the stored on-hand for a randomised property test                       | Met: sequential property (every accept/refuse decision and level matches the pure domain model, then the ledger replays to the stored level) and concurrent-burst property; soaked at 150 and 105 random cases with no failure. |
| Tenant-isolation suite extended and green                                                    | Met: every tenant table is checked generically; cross-tenant read, update, delete, insert, composite foreign key and append-only checks on all new tables; the database refuses impossible stock on its own.                    |

**Also verified:** the whole path API, database, Redis queue, a real worker process and back (including a 4,000-row, ~1 MB file in
about 10 seconds, a crashed-worker recovery, and per-row error reporting); a hand-driven run against the live server and worker.

**Independent review:** no critical or high defects; one medium that mattered (imports could never recover from a crashed worker)
and the lower findings are fixed and regression-tested (see architecture.md section 13).

**Known limits:** no order or purchasing flow yet (reservations are the hook for orders in Phase 3); one worker serves all tenants
(three imports in flight per business, no finer fairness); the counts of an import that was resumed after a crash are approximate;
no stock transfers between locations (adjust down and receive up instead); no returns movement yet; no catalog or inventory UI
(Phases 6 and 7); the ledger cannot yet be consumed as a global change feed (replay is per variant and location).

## 12. Milestone: business workspaces and role-based access control (2026-10-18)

**Delivered:** business profile (name, logo link, contact, address, currency `BDT`, time zone `Asia/Dhaka`, English/Bangla
default language) and a per-person language preference; workspace list and creation (`GET/POST /v1/workspaces`), switching
(existing `switch-tenant`), partial settings update (`PATCH /v1/tenant`, `tenant:update`), audit events `tenant.created`
(with origin), `tenant.updated` (changed field names only) next to the existing membership events; a row-level-security read
policy so a person can list only the businesses they belong to; shared screens (business list/switcher, create, settings) used
by web and mobile; the mobile app now signs in, with the refresh token in the device's secure storage. The permission matrix,
role-assignment rules and the five isolation layers are documented in [permissions.md](permissions.md).

**Found already in place (not rebuilt):** forced RLS on every tenant table, composite foreign keys, the per-request
membership and permission check in `AccessGuard`, roles, invitations, the audit log, and the isolation suite.

**Verification:** tenant-isolation suite (31) and the new `workspaces.e2e` suite (16: cross-tenant reads and writes, forged
ids, switching into strangers' or missing businesses, role changes taking effect on the next request, settings permissions)
green with the rest of the API integration suite; web Playwright scenarios for editing, creating, switching and read-only
settings; unit tests for the contract rules, the permission matrix and the native session storage.

**Known limits:** the logo is a link, not an upload (no file storage yet); screens are not translated into Bangla yet (the
preferences are stored and returned); the mobile app has no catalog screens yet; a person can own at most 10 businesses;
the mobile screens were type-checked and bundled for iOS but not driven on a simulator or device in this session.

## 13. Milestone: products and inventory module (2026-10-19)

Full design and the contract for orders and returns: [inventory.md](inventory.md).

**Found already in place (not rebuilt):** products with variants, SKU, description, cost and selling price in whole paisa,
reorder threshold, archiving and search, locations, the append-only ledger, reservations, low-stock alerts, receive and adjust
with reasons, background CSV import, and the concurrency tests behind "no overselling".

**Delivered:** suppliers; picture links; size and colour on variants (form and CSV); a **damaged** stock bucket with `DAMAGE`,
`WRITE_OFF` and `RETURN` ledger movements (database constraints, pure model, API, screens); returns that require an
idempotency key so a return processed twice adds units once; CSV **check before apply** (what would be created, updated or
skipped, with every problem row) and CSV **export** (catalog in the import columns, stock per location) with formula-injection
protection and auditing; web screens for all of it; the mobile app now has products, product page, stock and suppliers screens
built from the same shared screens.

**Verification:** inventory-module suite (25 API tests: product fields, suppliers incl. cross-business, damage / write-off /
return, idempotent returns and cancellations, exports, import preview), the existing property tests now mixing damaged stock
and returns into random sequential and concurrent runs, import through the real worker with the new columns, tenant-isolation
suite (now including `suppliers`), domain model and CSV tests, shared-screen render tests, web Playwright flows, mobile route
and storage tests.

**Known limits:** a supplier is a label on a product (no purchase orders yet); no transfers between locations; pictures are
links; mobile has no file import, categories or locations screens; the mobile screens were type-checked, bundled for iOS and
rendered in tests through the shared components, but not driven on a simulator or device.

## 14. Milestone: order management (2026-10-20)

Full design: [orders.md](orders.md).

**Delivered:** customers matched on a canonical Bangladeshi phone number, saved addresses and per-customer history (plain
counts, never a score or label); orders with several lines, discount, delivery charge, advance and a computed COD amount, all
totalled by the server (a pure function shared with the web/mobile preview, backed by database `CHECK` constraints); source
tracking; the status machine `pending_confirmation` → `confirmed` → `ready_to_ship` → `shipped` → `in_transit` →
`delivered` (+ `delivery_failed`, `cancelled`, `return_requested`, `returned`) with reasons, an append-only status history and an
audit trail; stock reserved on confirm (all lines or none), released on cancel, shipped on handover and restocked on return,
each exactly once; required idempotency keys on creation; per-tenant gap-free order numbers; duplicate-order hints; editing
rules by status with optimistic versions; search, filters, sorting and keyset paging; bulk status changes; CSV check/import and
export; orders and customers screens on web and mobile reading the real API.

**Adapted from the architecture:** state names follow the brief (mapping to DRAFT/PACKED/HANDED_OVER in orders.md); the
idempotency key is a body field like the stock endpoints (the route registry models bodies, not headers); partial delivery and
exchange are deferred.

**Verification:** 66 order-specific API tests (including tenant isolation for every read, write and attach-by-id, concurrent
confirm/cancel/return races, and a randomised orders-against-stock test), domain tests (every transition, stock effects,
totals property, phone numbers), shared-screen render tests, and 10 browser scenarios with accessibility and phone-width
checks. The pre-milestone checkpoint (create products, adjust stock, import a CSV, race the last units) and the post-milestone
checkpoint (create an order, reserve stock, change its status, cancel another, verify inventory and totals) are both automated
tests that pass.

**Known limits:** no couriers, shipments or COD reconciliation (next phases); no partial returns or exchanges; order import is
synchronous and capped at 500 orders; the mobile app has no file picker for CSV import; the mobile screens were type-checked,
bundled for iOS and rendered in tests through the shared components, but not driven on a simulator or device.

## 15. Milestone: web dashboard (2026-10-21)

Full description: [dashboard.md](dashboard.md).

**Delivered:** `GET /v1/dashboard` (counts by status, delivery, sales, daily series, low stock, all-time open work, recent
activity, and an estimated profit shown only when every delivered line has a recorded cost); the Dashboard screen (period tabs,
KPI cards that link to their lists, two real daily bar charts with spoken summaries, welcome/loading/error states); the Team and
permissions screen (people, invitations, role changes, removals and revocations with confirmations, and the real permission
matrix); a folding menu on phones; Dashboard as the first page after sign-in; sign-in returning to the business last used.

**Verification:** 15 dashboard API tests (including time zones, period edges, profit rules, isolation), screen tests for the
dashboard and team pages, 9 new browser scenarios including the end-to-end "seller's day" checkpoint run only through the UI
against the real API, accessibility and phone-width scans of the new pages.

**Known limits:** only today / 7 / 30-day periods; no courier fees, so profit is a labelled estimate of gross profit on item
revenue; no notifications; the mobile screens were not driven on a device.

## 16. Milestone: courier integration (2026-10-21)

Full description, credential setup and the list of what was and was not verified: [couriers.md](couriers.md).

**Delivered:** a provider-independent courier package (`packages/courier-sdk`: one interface with capabilities; Pathao,
Steadfast and a simulated adapter; HTTP with timeouts, retries, `Retry-After` and a rate limiter; provider status mapping with
the original text preserved; webhook verification by each courier's documented method); connections with credentials encrypted
at rest (AES-256-GCM, rotation, never returned or logged); shipments with duplicate-safe, idempotent booking claimed before the
courier is called, an explicit "unconfirmed" state settled by lookup or by a person, an append-only event trail, cancel where
supported, and order status/stock following courier updates through the order's own rules; a public webhook endpoint; Settings →
Couriers and a booking/tracking panel on the order page with clear simulated labelling; `couriers:read` and `couriers:manage`
permissions.

**Not verified against the real services:** the providers' official reference pages could not be read, so endpoints come from
each courier's own open-source plugin and community SDKs (classified in couriers.md). Pathao's price estimate and order-info
paths and Steadfast's header names rest on community sources. Nothing was run against a live or sandbox account.

**Verification:** 100 courier-package tests and 30 API integration tests against mocked HTTP, the vault tests, and 2 browser
scenarios. The checkpoint (book a test order with the simulated courier, track it through simulated updates, retry safely
without duplicates) is an automated API test and a browser scenario, both passing.

**Known limits:** no COD settlement (next phase); Pathao and Steadfast cannot cancel through the API; no background polling
(status refresh is by button or webhook); bulk booking is not built.

## 17. Milestone: COD reconciliation (2026-10-22)

Full description, definitions and calculations: [finance.md](finance.md).

**Delivered:** settlement CSV import (a documented format, refused whole on any bad line, with a check-only mode); settlement
batches and lines in integer paisa, backed by database constraints; matching by consignment id, tracking code, our reference or
(weakest) an order number with phone corroboration, never by phone or amount alone, and never guessed when identifiers
disagree; idempotent imports (same file once, no line recorded twice, duplicates kept but never counted); partial and full
matching; unmatched lines and discrepancies (shortfall, overpaid, cash before delivery, cash on a closed order, charge
differs, file arithmetic) that open, close and reopen by the facts; manual match / undo / set aside and resolve / waive with a
reason, line history, audit and `finance:adjust`; explicit reconcile that is refused while anything is unmatched or open;
outstanding COD where delivery is never proof of cash; sales, revenue, cash, outstanding COD, expenses and estimated profit
as separate figures, each with its source; manual costs; Finance screens on web and mobile.

**Not verified against real data:** real Pathao and Steadfast settlement exports were not available. The importer reads
OrderLoop's own documented CSV, and the whole flow was tested with fictional statements.

**Verification:** 20 domain tests (with property tests), 14 API integration tests against a real database including the
checkpoint, and 3 browser scenarios.

**Known limits:** statements say what couriers report, not what reached a bank; no bank reconciliation, partial delivery, taxes
or period closing.
