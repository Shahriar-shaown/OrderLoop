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

**Not verified (environment gaps):**

- `pnpm services:up` / Docker Compose: Docker is not installed on the development machine.
- Redis "up" path and the worker connecting to Redis: no Redis available (not installed, Docker missing).
- iOS Simulator / Android emulator launch: full Xcode is not installed (only command-line tools); no Android emulator.
- GitHub Actions workflow has not run (nothing pushed).

Notes: pnpm 11 manages `overrides`/`allowBuilds` in `pnpm-workspace.yaml` (mirrored in `package.json` `overrides` for Bun); `packages/db` and `courier-sdk` are created in the phases that need them; `@orderloop/contracts` has a browser-safe root entry and a Node-only `@orderloop/contracts/server` entry (found when the mobile bundle failed on `node:fs`).
