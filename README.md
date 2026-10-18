# OrderLoop

One loop. Every order. A Bangladesh-first platform for Facebook and Instagram sellers: orders, couriers, COD reconciliation, inventory and analytics.

**Current state: identity, tenancy, and the product catalog with stock control.** The API has accounts, tenants, roles, sessions, invitations and an audit log, plus products with variants, stock locations, an append-only stock ledger that cannot oversell, reservations, low-stock alerts and background CSV import, all isolated per tenant by PostgreSQL row-level security. Businesses have a profile (logo, contact, address, BDT / Asia/Dhaka / English-Bangla defaults), people belong to several through memberships with roles (owner, admin, manager, staff, accountant) and can switch between them; see [docs/permissions.md](docs/permissions.md). The web app has sign-in, the catalog and business settings screens; the mobile app has sign-in, a business list and switcher, creation and settings. Orders work end to end (customers, addresses, server-side totals, a validated status machine, stock reserved on confirm and released, shipped or restocked exactly once, bulk actions, CSV in and out, duplicate hints). There are no couriers or COD reconciliation yet.

- Plan: [docs/implementation-plan.md](docs/implementation-plan.md)
- Architecture decisions: [docs/architecture.md](docs/architecture.md)
- API reference, auth flows, errors, rate limits, email setup: [docs/api.md](docs/api.md)
- Data model, tenant isolation, migrations, seed data: [docs/database.md](docs/database.md)

## What is in the repo

```
apps/
  api/        NestJS 12 REST API (ESM). GET /health/live, GET /health/ready
  worker/     BullMQ worker process (connects to Redis; no jobs yet)
  web/        Next.js 16. Thin routes over the shared screens: sign-in, sign-up, password reset, catalog, stock
  mobile/     Expo SDK 57 + React Native + Expo Router. Sign-in and business screens from `packages/features` (refresh token in secure storage); `/status` is a development screen
packages/
  contracts/  Zod schemas and types shared by every app (health, env validation)
  api-client/ Typed fetch client built on the contracts (used by web and mobile)
  domain/     Pure business primitives with no I/O (money, stock ledger rules, CSV, permissions)
  ui/         Shared components with variants (React Native primitives; web renders them through react-native-web)
  features/   Shared screens and their logic (session, forms, queries); apps only mount them
  config/     Shared tsconfig and ESLint presets
infra/
  docker-compose.yml   PostgreSQL 16 (host port 5433) and Redis 7 (host port 6379)
scripts/      Version-drift and import-boundary checks
```

Import rules (enforced by `check:boundaries`): `web`/`mobile` never import `db`, `courier-sdk`, `api`, `worker` or `@orderloop/contracts/server`. `api` and `worker` never import each other.

## API playground

With the API running, open **http://localhost:4000/api-docs** for an interactive playground (Swagger UI, generated from the same route registry as `/openapi.json`). To call protected routes: run `POST /v1/auth/login`, copy `accessToken` from the response, click **Authorize** and paste it. It is not served when `NODE_ENV=production`.

## Web app and shared UI

The screens and components are written once in `packages/ui` and `packages/features` and used by web and mobile. See [docs/web.md](docs/web.md) for how it fits together, how to add a component, and how the browser tests work.

```bash
pnpm services:up && pnpm db:init   # PostgreSQL + Redis
pnpm services:mail                 # Mailpit, the inbox for verification and reset emails (http://localhost:8025)
pnpm --filter @orderloop/api dev   # API on :4000
pnpm --filter @orderloop/worker dev   # background imports
pnpm --filter @orderloop/web dev   # web on http://localhost:3000, start at /signup
```

To receive the emails in Mailpit instead of the API log, set `MAIL_PROVIDER=smtp`, `SMTP_HOST=127.0.0.1`, `SMTP_PORT=1025` in `.env` and restart the API.

## Database

`pnpm db:init` is safe to repeat. It runs two steps you can also run alone:

```bash
pnpm db:setup            # creates roles app_migrator (owns tables) and app_user (runtime, cannot bypass RLS)
pnpm db:migrate:deploy   # applies prisma/migrations as app_migrator
```

After editing `packages/db/prisma/schema.prisma`, create a migration with `pnpm db:migrate`. Tenant tables need hand-written row-level-security SQL in the migration; the isolation tests fail until it exists. The application connects only as `app_user` (`DATABASE_URL`); `DATABASE_ADMIN_URL` is a superuser used by `db:setup` and nothing else.

## API

Base URL `http://localhost:4000`. Machine-readable description: `GET /openapi.json` (also committed as [docs/openapi.json](docs/openapi.json)).

| Method and path                                                                                                                                                                           | Needs                                                | Purpose                                                                                                                                                           |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /health/live`, `/health/ready`                                                                                                                                                       | nothing                                              | Liveness and readiness (PostgreSQL, Redis)                                                                                                                        |
| `POST /v1/auth/register`                                                                                                                                                                  | nothing                                              | Create a user and a tenant they own                                                                                                                               |
| `POST /v1/auth/login`                                                                                                                                                                     | nothing                                              | Sign in (optional `tenantId` to choose the tenant)                                                                                                                |
| `POST /v1/auth/refresh`                                                                                                                                                                   | refresh token                                        | Rotate tokens; reuse of an old token ends the session                                                                                                             |
| `POST /v1/auth/logout`                                                                                                                                                                    | access token                                         | Revoke the session immediately                                                                                                                                    |
| `POST /v1/auth/switch-tenant`                                                                                                                                                             | access token                                         | Re-scope the session to another tenant                                                                                                                            |
| `POST /v1/auth/accept-invitation`                                                                                                                                                         | invitation token                                     | Join a tenant (creates the account if needed)                                                                                                                     |
| `GET/PATCH /v1/me`, `GET/PATCH /v1/tenant`                                                                                                                                                | access token; `tenant:update`                        | Current user and role; business profile and settings                                                                                                              |
| `GET/POST /v1/workspaces`                                                                                                                                                                 | access token                                         | Your businesses with your role; create another                                                                                                                    |
| `GET/POST/PATCH/DELETE /v1/members`                                                                                                                                                       | `members:*` permission                               | List, invite (`/invitations`), change role, remove                                                                                                                |
| `GET/POST /v1/products`, `GET/PATCH /v1/products/:id`, `POST /v1/products/:id/variants`, `PATCH /v1/variants/:id`                                                                         | `catalog:read` / `catalog:write`                     | Products with variants (SKU, price in paisa); search, archive                                                                                                     |
| `GET/POST /v1/categories`, `PATCH/DELETE /v1/categories/:id`, `GET/POST /v1/locations`, `PATCH /v1/locations/:id`                                                                         | `catalog:*` / `inventory:read`                       | Categories and stock locations                                                                                                                                    |
| `GET /v1/inventory`, `POST /v1/inventory/receive`, `/adjust`, `/damage`, `/write-off`, `/return`, `GET /v1/inventory/movements`, `/low-stock`                                             | `inventory:read` / `inventory:write`                 | Stock levels (on hand, reserved, damaged), the ledger, low-stock alerts, returns                                                                                  |
| `GET /v1/dashboard`                                                                                                                                                                       | `orders:read`                                        | Dashboard figures worked out by the server (counts, sales, delivery, low stock, estimated profit, activity); see [docs/dashboard.md](docs/dashboard.md)           |
| `GET/POST /v1/orders`, `GET/PATCH /v1/orders/:id`, `POST /v1/orders/:id/status`, `/orders/bulk-status`, `/orders/duplicate-check`                                                         | `orders:read` / `orders:write`                       | Orders with server-side totals, a validated status machine, stock reserved on confirm; see [docs/orders.md](docs/orders.md)                                       |
| `GET/POST/PATCH /v1/customers`, `/customers/:id/addresses`, `/customers/:id/orders`                                                                                                       | `orders:read` / `orders:write`                       | Customers (matched on phone), addresses, order history                                                                                                            |
| `POST /v1/imports/orders` (+ `/validate`), `GET /v1/exports/orders`                                                                                                                       | `orders:write` / `orders:read`                       | Check, then import, orders from CSV; export orders                                                                                                                |
| `GET/PATCH/DELETE /v1/couriers`, `POST /v1/orders/:id/shipments`, `GET /v1/shipments/:id`, `/shipments/:id/refresh`, `/cancel`, `/resolve`, `/simulate`, `POST /v1/webhooks/couriers/...` | `couriers:read` / `couriers:manage` / `orders:write` | Pathao, Steadfast and a simulated courier behind one interface; encrypted credentials; duplicate-safe booking; webhooks; see [docs/couriers.md](docs/couriers.md) |
| `GET/POST /v1/suppliers`, `PATCH /v1/suppliers/:id`                                                                                                                                       | `catalog:read` / `catalog:write`                     | Suppliers                                                                                                                                                         |
| `POST /v1/imports/products/validate`, `GET /v1/exports/products`, `/v1/exports/stock`                                                                                                     | `catalog:write` / `catalog:read` / `inventory:read`  | Check a CSV before importing; export the catalog or stock as CSV                                                                                                  |
| `GET/POST /v1/reservations`, `POST /v1/reservations/:id/release`, `/fulfil`                                                                                                               | `inventory:read` / `inventory:write`                 | Hold stock; resolves exactly once; `409 insufficient_stock`                                                                                                       |
| `POST /v1/imports/products`, `GET /v1/imports`, `GET /v1/imports/:id`                                                                                                                     | `catalog:write`                                      | CSV catalog import, processed by the worker (returns 202)                                                                                                         |
| `GET /v1/audit-logs`                                                                                                                                                                      | `audit:read` (OWNER, ADMIN)                          | Tenant audit trail, newest first, cursor paginated                                                                                                                |

Try it:

```bash
curl -s -X POST localhost:4000/v1/auth/register -H 'content-type: application/json' \
  -d '{"email":"you@example.com","password":"a long passphrase","name":"You","tenantName":"My Shop"}'
# then: curl -s localhost:4000/v1/me -H "authorization: Bearer <accessToken from above>"
```

Browsers send `x-client: web` and receive the refresh token as an HttpOnly cookie; native apps receive it in the JSON body. Access tokens last 15 minutes. In development the signing key is generated at start-up, so restarting the API signs everyone out; production requires `JWT_PRIVATE_KEY` and `JWT_PUBLIC_KEY` (`pnpm --filter @orderloop/api auth:generate-keys`). Emails (verification, password reset, invitations) are printed in the API log in development; see [docs/api.md](docs/api.md#email) to read them in a local Mailpit inbox or configure a real SMTP provider.

## Prerequisites

| Tool                      | Version                                   | Notes                                                           |
| ------------------------- | ----------------------------------------- | --------------------------------------------------------------- |
| Node.js                   | 22.12+ (see `.nvmrc`)                     | `nvm use`                                                       |
| pnpm                      | 11.28.6 (pinned in `package.json`)        | Via corepack, below. **Primary package manager and lockfile.**  |
| Docker Desktop            | recent                                    | For local PostgreSQL and Redis                                  |
| Xcode (macOS, optional)   | full install, not only command-line tools | Only to run the iOS Simulator                                   |
| Android Studio (optional) | recent                                    | Only to run the Android emulator                                |
| Bun (optional)            | 1.3+                                      | Supported as an alternative runner, see [Using Bun](#using-bun) |

## Install

```bash
nvm use
corepack enable
corepack prepare pnpm@11.28.6 --activate
pnpm install
cp .env.example .env
```

`.env.example` contains only local-development defaults that match `infra/docker-compose.yml`. Never put real credentials in it. `.env` is git-ignored.

## Start local services (PostgreSQL and Redis)

```bash
pnpm services:up      # waits until both containers are healthy
```

PostgreSQL listens on `localhost:5433` (not 5432, so it does not clash with a Homebrew Postgres). Redis listens on `localhost:6379`. Stop them with `pnpm services:down`; view logs with `pnpm services:logs`.

## Run the apps

Run everything (API, worker, web and the Expo dev server) in one terminal:

```bash
pnpm dev
```

Or run one at a time:

```bash
pnpm --filter @orderloop/api dev       # http://localhost:4000
pnpm --filter @orderloop/worker dev
pnpm --filter @orderloop/web dev       # http://localhost:3000
pnpm --filter @orderloop/mobile start  # Expo dev server (Metro on :8081)
```

### Verify the backend

```bash
curl -i http://localhost:4000/health/live    # 200 {"status":"ok"}
curl -i http://localhost:4000/health/ready   # 200 when PostgreSQL and Redis are reachable
```

`/health/ready` returns `503` with `{"status":"degraded","checks":{"postgres":"up|down","redis":"up|down"}}` when a dependency is unreachable.

### Web

Open http://localhost:3000. The page is labelled **Development build** and shows the API URL and the live result of `/health/ready`. If the API is not running, it says `unreachable`.

### Mobile

```bash
pnpm --filter @orderloop/mobile start
```

Then press `i` (iOS Simulator, needs Xcode) or `a` (Android emulator), or scan the QR code with Expo Go on a phone. Tap **Check API health** on the home screen.

**Android emulator setup (one time).** Install Android Studio, open it once so it downloads the SDK, and create a virtual device in Device Manager. Then add these to `~/.zshrc`:

```bash
export ANDROID_HOME="$HOME/Library/Android/sdk"
export PATH="$ANDROID_HOME/emulator:$ANDROID_HOME/platform-tools:$PATH"
```

Inside the emulator, `localhost` is the emulator itself, not your computer. Forward the ports once per emulator boot, then run `pnpm --filter @orderloop/mobile android`:

```bash
adb reverse tcp:4000 tcp:4000   # API
adb reverse tcp:8081 tcp:8081   # Metro
```

(Alternatively set `EXPO_PUBLIC_API_URL=http://10.0.2.2:4000`, the emulator's alias for the host.) The iOS Simulator shares the host network, so it needs nothing extra.

**No Xcode? iOS without a Mac simulator.** Install **Expo Go** from the App Store on an iPhone and scan the QR code that `pnpm --filter @orderloop/mobile start` prints. The iOS Simulator itself needs full Xcode, which is macOS-only.

A physical phone cannot reach `localhost`. Set `EXPO_PUBLIC_API_URL` in `.env` to your computer's LAN address, for example `http://192.168.1.20:4000`, and restart the Expo server. The phone and computer must be on the same network.

## Quality checks

```bash
pnpm lint            # ESLint in every workspace
pnpm typecheck       # TypeScript in every workspace
pnpm test            # Vitest unit tests + script tests (no database needed)
pnpm test:e2e        # (in apps/web) browser tests: real Chrome against API, worker, web, Mailpit; needs services:up and services:mail
pnpm test:integration # API tests against real PostgreSQL + Redis (needs services:up); uses the isolated orderloop_test database
pnpm build           # builds packages, api, worker, web (next build), mobile (expo export, iOS)
pnpm format          # Prettier: write
pnpm format:check    # Prettier: verify only
pnpm check:versions  # React/TypeScript/Zod pins and Expo SDK consistency
pnpm check:boundaries
pnpm check           # lint + typecheck + test + build + both checks above
```

### Environment-variable validation

- `api` and `worker` validate server variables at start-up (`@orderloop/contracts/server`) and exit with a list of every invalid variable.
- `web` and `mobile` validate `NEXT_PUBLIC_API_URL` / `EXPO_PUBLIC_API_URL` when the app loads (`parsePublicEnv`).
- Next.js and Expo read `.env` only from their own folder, so `apps/web/next.config.ts` and `apps/mobile/scripts/with-root-env.mjs` load the single root `.env` first.

### Version pins

React is pinned to **19.2.3** for web and mobile because Expo SDK 57 bundles that version. Prisma, when added, will be pinned to 7.10.0, and TypeScript to 6.0.3. See [docs/architecture.md](docs/architecture.md) section 2.

## Using Bun

pnpm is the supported package manager and owns the committed lockfile (`pnpm-lock.yaml`). The scripts are package-manager-neutral and the root `package.json` declares `workspaces`, so Bun also works:

```bash
bun install
bun run check
bun run dev
```

Bun lockfiles (`bun.lock`) are git-ignored. To make Bun the primary tool instead, change `packageManager` in `package.json` and commit `bun.lock`; this needs a team decision because Turborepo reads `packageManager` to choose the package manager.

## Troubleshooting

| Symptom                                   | Fix                                                                                         |
| ----------------------------------------- | ------------------------------------------------------------------------------------------- |
| `docker: command not found`               | Install Docker Desktop and start it.                                                        |
| `/health/ready` shows `postgres: down`    | Run `pnpm services:up`. Confirm `DATABASE_URL` uses port **5433**.                          |
| `Invalid environment: DATABASE_URL ...`   | You skipped `cp .env.example .env`.                                                         |
| Expo says it cannot find Xcode            | Install full Xcode, then `sudo xcode-select -s /Applications/Xcode.app/Contents/Developer`. |
| Android emulator shows `unreachable`      | Run the two `adb reverse` commands above.                                                   |
| Phone shows `unreachable`                 | Use your LAN IP in `EXPO_PUBLIC_API_URL`, not `localhost`.                                  |
| `.next` errors after an interrupted build | Delete `apps/web/.next` and rerun.                                                          |

## Not built yet

Mobile sign-in and catalog screens (the shared screens exist; native session storage does not yet), COD reconciliation and analytics. Couriers are built but have only been tested against a simulated courier and mocked HTTP, not a real Pathao or Steadfast account (see [docs/couriers.md](docs/couriers.md)). See the phases in [docs/implementation-plan.md](docs/implementation-plan.md).
