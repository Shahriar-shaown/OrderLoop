# OrderLoop

One loop. Every order. A Bangladesh-first platform for Facebook and Instagram sellers: orders, couriers, COD reconciliation, inventory and analytics.

**Current state: foundation plus identity and tenancy.** The API has accounts, tenants, roles, sessions, invitations and an audit log, isolated per tenant by PostgreSQL row-level security. There are no business features (catalog, orders, couriers) yet, and the web and mobile apps are still placeholder screens that do not use the auth API.

- Plan: [docs/implementation-plan.md](docs/implementation-plan.md)
- Architecture decisions: [docs/architecture.md](docs/architecture.md)

## What is in the repo

```
apps/
  api/        NestJS 12 REST API (ESM). GET /health/live, GET /health/ready
  worker/     BullMQ worker process (connects to Redis; no jobs yet)
  web/        Next.js 16 + Tailwind CSS 4. One clearly labelled development page
  mobile/     Expo SDK 57 + React Native + Expo Router. One labelled development home screen
packages/
  contracts/  Zod schemas and types shared by every app (health, env validation)
  api-client/ Typed fetch client built on the contracts (used by web and mobile)
  domain/     Pure business primitives with no I/O (currently only integer-paisa money helpers)
  config/     Shared tsconfig and ESLint presets
infra/
  docker-compose.yml   PostgreSQL 16 (host port 5433) and Redis 7 (host port 6379)
scripts/      Version-drift and import-boundary checks
```

Import rules (enforced by `check:boundaries`): `web`/`mobile` never import `db`, `courier-sdk`, `api`, `worker` or `@orderloop/contracts/server`. `api` and `worker` never import each other.

## Database

`pnpm db:init` is safe to repeat. It runs two steps you can also run alone:

```bash
pnpm db:setup            # creates roles app_migrator (owns tables) and app_user (runtime, cannot bypass RLS)
pnpm db:migrate:deploy   # applies prisma/migrations as app_migrator
```

After editing `packages/db/prisma/schema.prisma`, create a migration with `pnpm db:migrate`. Tenant tables need hand-written row-level-security SQL in the migration; the isolation tests fail until it exists. The application connects only as `app_user` (`DATABASE_URL`); `DATABASE_ADMIN_URL` is a superuser used by `db:setup` and nothing else.

## API

Base URL `http://localhost:4000`. Machine-readable description: `GET /openapi.json` (also committed as [docs/openapi.json](docs/openapi.json)).

| Method and path                     | Needs                       | Purpose                                               |
| ----------------------------------- | --------------------------- | ----------------------------------------------------- |
| `GET /health/live`, `/health/ready` | nothing                     | Liveness and readiness (PostgreSQL, Redis)            |
| `POST /v1/auth/register`            | nothing                     | Create a user and a tenant they own                   |
| `POST /v1/auth/login`               | nothing                     | Sign in (optional `tenantId` to choose the tenant)    |
| `POST /v1/auth/refresh`             | refresh token               | Rotate tokens; reuse of an old token ends the session |
| `POST /v1/auth/logout`              | access token                | Revoke the session immediately                        |
| `POST /v1/auth/switch-tenant`       | access token                | Re-scope the session to another tenant                |
| `POST /v1/auth/accept-invitation`   | invitation token            | Join a tenant (creates the account if needed)         |
| `GET /v1/me`, `GET /v1/tenant`      | access token                | Current user, role, permissions; current tenant       |
| `GET/POST/PATCH/DELETE /v1/members` | `members:*` permission      | List, invite (`/invitations`), change role, remove    |
| `GET /v1/audit-logs`                | `audit:read` (OWNER, ADMIN) | Tenant audit trail, newest first, cursor paginated    |

Try it:

```bash
curl -s -X POST localhost:4000/v1/auth/register -H 'content-type: application/json' \
  -d '{"email":"you@example.com","password":"a long passphrase","name":"You","tenantName":"My Shop"}'
# then: curl -s localhost:4000/v1/me -H "authorization: Bearer <accessToken from above>"
```

Browsers send `x-client: web` and receive the refresh token as an HttpOnly cookie; native apps receive it in the JSON body. Access tokens last 15 minutes. In development the signing key is generated at start-up, so restarting the API signs everyone out; production requires `JWT_PRIVATE_KEY` and `JWT_PUBLIC_KEY` (`pnpm --filter @orderloop/api auth:generate-keys`). Invitation emails are not sent yet: in development the link is printed in the API log.

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

Email delivery, password reset and verification, login screens in web and mobile, catalog, orders, couriers, COD reconciliation and analytics. See the phases in [docs/implementation-plan.md](docs/implementation-plan.md).
