# Deployment guide (production / pilot)

How to run OrderLoop outside a laptop. The repository provides **deployment artifacts for one Docker host** (a pilot, not a
high-availability setup): production images for the api, worker, web, the migration job and the backup tooling
([`deploy/Dockerfile`](../../deploy/Dockerfile)), a Compose stack with a reverse proxy that obtains HTTPS certificates by itself
([`deploy/docker-compose.yml`](../../deploy/docker-compose.yml), [`deploy/Caddyfile`](../../deploy/Caddyfile)), a secrets generator
([`deploy/generate-secrets.sh`](../../deploy/generate-secrets.sh)), a documented environment file
([`deploy/.env.example`](../../deploy/.env.example)), encrypted backups with a restore drill ([`ops/`](../../ops)), and a monitoring
profile. `.github/workflows/ci.yml` has a job `images` that builds the images, validates the compose file and the monitoring rules, and does not push or deploy anything (its commands were run locally; the job itself has not been seen running on GitHub).
`infra/docker-compose.yml` remains the **development** stack (PostgreSQL, Redis, Mailpit with development passwords): never use it in production.

> **What was tested, honestly.** On 2026-10-21, on a developer laptop (Docker Desktop, arm64): all five images were built from a
> clean context; the stack was started under a throwaway project name on non-default ports with `NODE_ENV=production`; the migrate
> job ran; `/health/ready` answered 200 through Caddy over HTTPS (Caddy's own local CA); a sign-up with a non-allowlisted email was
> refused and an allowlisted one succeeded; a product was created through the API; the verification email was delivered over
> STARTTLS to a test mail server whose certificate came from a throwaway CA; `/metrics` was refused without the token; a real
> backup, the restore drill and its failure cases ran; the monitoring profile ran and an alert fired
> (details in [section 14](#14-what-was-tested-and-what-was-not), commands in [section 0](#0-quick-start-single-host)).
> **Not tested:** a real server, a real domain, Let's Encrypt (Caddy's internal CA was used locally), a real SMTP provider, a
> multi-host or managed-database setup, Kubernetes or Terraform (none provided), off-site backup upload to a real bucket, a
> browser session, Linux (only Docker Desktop on macOS), load, an upgrade of a running system with data, or a rollback.
> Nothing here is a certification or a claim that the system is ready for production.

Related: [migrations.md](migrations.md), [backup-and-restore.md](backup-and-restore.md), [monitoring.md](monitoring.md),
[incident-response.md](incident-response.md), [../release/pilot-checklist.md](../release/pilot-checklist.md).

## 0. Quick start (single host)

Prerequisites: a Linux host with Docker Engine and the Compose plugin, ports 80 and 443 open to the internet, DNS `A` records for
`app.<domain>` and `api.<domain>` pointing at it (same registrable domain: see [section 6](#6-cors-origins-and-cookies)), an SMTP
account with a verified sending domain ([email setup](#email-setup-spf-dkim-dmarc-and-a-test-send)), and `openssl` plus `age`
(`apt install age`) or the built ops image on the machine that runs the secrets generator.

```bash
git clone <your repository> && cd OrderLoop && git checkout <release tag>

# 1. Secrets: writes deploy/.env (mode 600) from deploy/.env.example with every secret generated, and the backup PRIVATE key to
#    deploy/backup-age-identity.txt (mode 600). Nothing secret is printed.
./deploy/generate-secrets.sh
# 2. Edit deploy/.env: DOMAIN, ACME_EMAIL, MAIL_FROM, SMTP_*, REGISTRATION_MODE / REGISTRATION_ALLOWED_EMAILS, META_MODE,
#    NEXT_PUBLIC_PRIVACY_CONTACT. Then MOVE deploy/backup-age-identity.txt off the host and back up COURIER_CREDENTIALS_KEY separately.

# 3. Build (the web image bakes in NEXT_PUBLIC_API_URL, so build after setting DOMAIN) and start
docker compose -f deploy/docker-compose.yml build
docker compose -f deploy/docker-compose.yml up -d
docker compose -f deploy/docker-compose.yml ps         # migrate: exited (0); the others: healthy

# 4. Check
curl -i https://api.<domain>/health/ready              # 200 {"status":"ok","checks":{"postgres":"up","redis":"up"}}
docker compose -f deploy/docker-compose.yml exec api node dist/scripts/mail-test.js --to you@example.com
docker compose -f deploy/docker-compose.yml exec backup backup.sh                          # a first backup now
docker compose -f deploy/docker-compose.yml --profile ops run --rm \
  -v "$PWD/deploy/backup-age-identity.txt:/run/secrets/age-identity:ro" drill               # restore drill, must print RESULT: PASS
docker compose -f deploy/docker-compose.yml --profile monitoring up -d                     # optional: Prometheus, Alertmanager, Grafana
```

`./deploy/smoke-test.sh` repeats all of this on a laptop under a throwaway project name on ports 18080/18443 (`--only stack|backup|monitoring`
for parts, `--keep` to leave the stack up) and tears it down; it is what produced the evidence quoted in these documents. A local
test uses a domain ending in `.test` (the web app refuses a production build that points at `localhost`).

What the Compose stack does, in order: PostgreSQL 16 and Redis 7 (append-only file) start; the **migrate** job creates the roles
(`app_migrator`, `app_user`, plus the read-only backup role and a statistics-only monitoring role), runs `prisma migrate deploy` as the
owner role and checks the status; api, worker and the backup loop start only after it exited with 0; Caddy publishes 80/443 and
proxies `app.<domain>` to the web container and `api.<domain>` to the API (answering 404 for `/metrics`). Only Caddy has a published port. api, worker and web run
as the unprivileged `node` user with a read-only root filesystem and all capabilities dropped; every service has a memory and CPU limit and a restart policy.
Every image tag is pinned exactly; the stack builds the application images locally (`orderloop-<service>:<IMAGE_TAG>`), nothing is pulled from a project registry.

Operating it: update = `git checkout <new tag>`, `docker compose build`, `docker compose up -d` (the migrate job runs first; read
[migrations.md](migrations.md) before a release with a migration); logs = `docker compose logs -f api worker`; stop = `docker compose down` (never `-v` on a real
deployment: it deletes the database volume); rollback = [section 13](#13-rollback).

## 1. Architecture

```
 phones (Expo app)            browsers
        \                       |
         \                 https://app.example.com ──► [reverse proxy / TLS] ──► web   (Next.js, port 3000)
          \                                                                           (browser calls the API directly)
           └────────────► https://api.example.com ──► [reverse proxy / TLS] ──► api   (NestJS, API_PORT, default 4000)
                                                                                      │        │
 couriers, Meta (webhooks) ──► https://api.example.com (public webhook routes)       │        │
                                                              PostgreSQL 16 ◄────────┘        └──► Redis 7
                                                                    ▲                                ▲
                                                                    └─────── worker (BullMQ; internal health/metrics port) ┘
 api and worker ──► SMTP provider, Expo push service (optional), Meta Graph API (live mode), courier APIs
```

| Component         | Process                                                       | State                            | Notes                                                                                                                                                                    |
| ----------------- | ------------------------------------------------------------- | -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **api**           | `node apps/api/dist/main.js`                                  | none (all in PostgreSQL / Redis) | REST API, public webhooks, the only thing browsers and phones call. Serves no HTML. `/api-docs` is **not** served when `NODE_ENV=production`.                            |
| **worker**        | `node apps/worker/dist/main.js`                               | none                             | Imports, automation, notification delivery, Meta event processing, sweepers, retention, business purge. HTTP health and metrics on `WORKER_HEALTH_PORT` (internal only). |
| **web**           | `next start -p 3000` in `apps/web`                            | none                             | Thin Next.js shell over the shared screens. The browser talks to the API directly (cross-origin).                                                                        |
| **mobile**        | Built with EAS, installed from stores / internal distribution | on device                        | Not a server. Points at one API URL fixed at build time.                                                                                                                 |
| **PostgreSQL**    | 16                                                            | all business data                | Roles `app_migrator` (owner) and `app_user` (runtime), forced RLS. Backups: [backup-and-restore.md](backup-and-restore.md).                                              |
| **Redis**         | 7                                                             | queues and lockout counters only | Not durable by design. Password + TLS (`rediss://`) if networked.                                                                                                        |
| **SMTP**          | any provider                                                  | none                             | Verification, password reset, invitations, notification email.                                                                                                           |
| **Reverse proxy** | Caddy in the provided stack (any other works)                 | certificates (Caddy volume)      | TLS termination, HTTPS only, automatic certificates.                                                                                                                     |
| **backup**        | `ops/backup-loop.sh` in the ops image                         | encrypted dumps in a volume      | Nightly `pg_dump` of every tenant's data, age-encrypted ([backup-and-restore.md](backup-and-restore.md)).                                                                |

WebSockets are **not** used anywhere (the app polls); the proxy needs no upgrade handling.

## 2. Prerequisites

- Node.js **22.12 or newer** (`.nvmrc` says 22), pnpm **11.28.6** (`corepack enable && corepack prepare pnpm@11.28.6 --activate`), on the build machine and the runtime hosts.
- PostgreSQL 16 and Redis 7 reachable from api and worker; a superuser (or equivalent) **once**, for `pnpm db:setup` and for backups.
- Two public hostnames with TLS certificates, on the **same registrable domain** (for example `app.example.com` and `api.example.com`; see [cookies](#6-cors-origins-and-cookies)).
- An SMTP account with a verified sending domain (SPF, DKIM, DMARC).
- A secret manager or equivalent for everything in [section 4](#4-secrets).
- For the mobile apps: Expo (EAS) account, Apple Developer and Google Play accounts ([section 11](#11-mobile-release-path)).
- A tagged git release to build from.

## 3. Environment variables

The API and worker validate their environment at start-up with the same schema (`packages/contracts/src/server-env.ts`): a bad or missing
value stops the process with every problem listed (values are not echoed), and prints one JSON line with `"event":"unhandled_error"`. A variable that is set but **blank**
counts as not set. The worker is not asked for the production settings only the API uses (`JWT_*`, `TRUST_PROXY`, `WEB_ORIGINS`, `REGISTRATION_MODE`), so it is not given the token-signing key.
`deploy/.env.example` documents every variable of the Compose deployment (a repository test fails if a variable of the schema or of the Compose file is missing from it). Variables already in the process environment win over a
`.env` file; in production prefer real environment variables (the `.env` loader walks up from the working directory and is a development convenience).

### Shared by api and worker

| Variable                                                                            | Required                                        | Notes                                                                                                                                                                                                                                      |
| ----------------------------------------------------------------------------------- | ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `NODE_ENV`                                                                          | **yes**, no default                             | Must be `production`. Production turns on the refusals below and Secure cookies.                                                                                                                                                           |
| `DATABASE_URL`                                                                      | yes                                             | URL of **`app_user`** (runtime role). Never the owner or a superuser: that would switch off row-level security for the application.                                                                                                        |
| `REDIS_URL`                                                                         | yes                                             | `redis://` or `rediss://` (TLS and password supported).                                                                                                                                                                                    |
| `LOG_LEVEL`                                                                         | no (`info`)                                     | Do not leave `debug`/`trace` on.                                                                                                                                                                                                           |
| `MAIL_PROVIDER`                                                                     | yes in production                               | `smtp`. `console` is **refused** in production (it prints one-time links).                                                                                                                                                                 |
| `MAIL_FROM`                                                                         | yes in production                               | Sender your provider allows, for example `OrderLoop <no-reply@example.com>` (default is an `.invalid` address).                                                                                                                            |
| `SMTP_HOST`, `SMTP_PORT`, `SMTP_SECURE`, `SMTP_USER`, `SMTP_PASSWORD`               | `SMTP_HOST` required with `smtp`                | Port 587 + `SMTP_SECURE=false` (STARTTLS) or 465 + `true`. `SMTP_USER` and `SMTP_PASSWORD` both or neither.                                                                                                                                |
| `PUSH_PROVIDER`                                                                     | no (`dev`)                                      | `dev` only logs ("sent" is recorded but nothing reaches a phone; logs a loud warning in production). `expo` for real pushes. **Same value on api and worker.**                                                                             |
| `EXPO_ACCESS_TOKEN`                                                                 | only if the Expo project enforces access tokens | With `PUSH_PROVIDER=expo`.                                                                                                                                                                                                                 |
| `PUSH_DEV_OUTBOX`                                                                   | never in production                             | Writes would-be pushes to a file.                                                                                                                                                                                                          |
| `SMS_PROVIDER`, `WHATSAPP_PROVIDER`                                                 | no (`none`)                                     | `none` makes the channel unavailable; `console` only logs. No vendor is integrated. Same on api and worker.                                                                                                                                |
| `COURIER_CREDENTIALS_KEY`                                                           | yes if any real courier or live Meta is used    | 32 random bytes, base64. Same value on api **and** worker. Without it Pathao/Steadfast cannot be connected.                                                                                                                                |
| `COURIER_CREDENTIALS_KEY_ID`                                                        | no (`k1`)                                       | Name stored beside each sealed secret.                                                                                                                                                                                                     |
| `COURIER_CREDENTIALS_OLD_KEYS`                                                      | no                                              | `id:base64,id:base64`, retired keys still needed to read old secrets.                                                                                                                                                                      |
| `META_MODE`                                                                         | no (`mock`)                                     | `mock` or `live`. See [section 10](#10-defaults-that-matter-push-meta-couriers-sms).                                                                                                                                                       |
| `META_APP_ID`, `META_APP_SECRET`, `META_WEBHOOK_VERIFY_TOKEN`, `META_GRAPH_VERSION` | all four required when `META_MODE=live`         | Plus `API_PUBLIC_URL` and `COURIER_CREDENTIALS_KEY`. The process refuses to start otherwise. `META_APP_SECRET` and the verify token are 16+ characters. `META_GRAPH_VERSION` like `v23.0`, no default: pick a currently supported version. |
| `META_LOGIN_CONFIG_ID`, `META_RETENTION_DAYS`                                       | no (`30`)                                       | Retention 1 to 365 days.                                                                                                                                                                                                                   |
| `METRICS_TOKEN`                                                                     | no (metrics off)                                | 16+ characters. Opens `GET /metrics` (bearer token) on the API and on the worker's health server; both answer 404 without it. [monitoring.md](monitoring.md#metrics-metrics).                                                              |
| `WORKER_HEALTH_PORT`                                                                | no (`4010`)                                     | Port of the worker's `/health/live`, `/health/ready` and `/metrics`. Internal network only.                                                                                                                                                |
| `TENANT_DELETION_GRACE_DAYS`                                                        | no (`14`)                                       | Days between an owner's deletion request and the worker's permanent purge ([../privacy-and-deletion.md](../privacy-and-deletion.md)).                                                                                                      |

### api only

| Variable                            | Required                                             | Notes                                                                                                                                                                                                                                                                                                            |
| ----------------------------------- | ---------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `API_PORT`                          | no (`4000`)                                          | Listen port.                                                                                                                                                                                                                                                                                                     |
| `JWT_PRIVATE_KEY`, `JWT_PUBLIC_KEY` | **yes in production**, both or neither               | Base64 PEM of an Ed25519 key pair. Without them development generates an ephemeral key; production refuses to start.                                                                                                                                                                                             |
| `ACCESS_TOKEN_TTL_SECONDS`          | no (`900`)                                           | 60 to 3600.                                                                                                                                                                                                                                                                                                      |
| `REFRESH_TOKEN_TTL_DAYS`            | no (`30`)                                            | 1 to 90.                                                                                                                                                                                                                                                                                                         |
| `REFRESH_REUSE_GRACE_SECONDS`       | no (`10`)                                            | 0 to 60; 0 turns the retry grace off.                                                                                                                                                                                                                                                                            |
| `WEB_ORIGINS`                       | yes in practice (default is `http://localhost:3000`) | Comma-separated exact browser origins allowed with credentials, e.g. `https://app.example.com`. No path, no trailing slash. The first one is also where emailed links point.                                                                                                                                     |
| `WEB_APP_URL`                       | no                                                   | Where the Meta sign-in returns to (default: first `WEB_ORIGINS`).                                                                                                                                                                                                                                                |
| `TRUST_PROXY`                       | no (`0`), **set it**                                 | Exact number of reverse-proxy hops in front of the API (0 to 5). Wrong values break per-IP rate limits and make the logged IP spoofable or the same for everyone.                                                                                                                                                |
| `API_PUBLIC_URL`                    | yes for webhooks                                     | Public `https://` address of the API; shown to sellers as the webhook address; **must be https in production** or the API refuses to start.                                                                                                                                                                      |
| `COURIER_MOCK_ENABLED`              | no                                                   | The simulated courier: on by default outside production; in production it is off unless set to `true`. Leave off unless the pilot deliberately uses it.                                                                                                                                                          |
| `RATE_LIMIT_ENABLED`                | no (`true`)                                          | `false` is for automated tests only. Never in production.                                                                                                                                                                                                                                                        |
| `REGISTRATION_MODE`                 | **yes in production, no default**                    | `allowlist` (pilot) or `open`. The API refuses to start in production without an explicit choice, so a deploy cannot quietly let anyone create a business. Outside production the default is `open`. With `allowlist`, `REGISTRATION_ALLOWED_EMAILS` is required ([sign-up policy](#production-sign-up-policy)). |
| `REGISTRATION_ALLOWED_EMAILS`       | with `allowlist`                                     | Comma-separated exact emails and/or `@domain.com`.                                                                                                                                                                                                                                                               |

### worker only

The worker reads the shared set above (`DATABASE_URL`, `REDIS_URL`, `MAIL_*`/`SMTP_*`, `PUSH_*`, `SMS_*`, `WHATSAPP_*`, `COURIER_CREDENTIALS_*`, `META_*`, `METRICS_TOKEN`, `WORKER_HEALTH_PORT`, `LOG_LEVEL`). It validates the same schema with the API-only production requirements skipped, and the Compose file does not give it `JWT_*`, `WEB_ORIGINS`, `TRUST_PROXY` or `REGISTRATION_*`. It needs outbound access to Redis, PostgreSQL, SMTP, `exp.host` (if `expo`) and the Graph API (if `live`).

### Migration and setup tooling only (not runtime)

| Variable                 | Used by                                    | Notes                                                                |
| ------------------------ | ------------------------------------------ | -------------------------------------------------------------------- |
| `DATABASE_MIGRATION_URL` | `pnpm db:migrate:deploy`, `migrate:status` | URL of **`app_migrator`** (table owner). Not given to api or worker. |
| `DATABASE_ADMIN_URL`     | `pnpm db:setup` only                       | Superuser URL. **Not** given to any running service.                 |

### web (build time and run time)

| Variable                      | When                             | Notes                                                                                                                                                                                                                                                                              |
| ----------------------------- | -------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `NEXT_PUBLIC_API_URL`         | **build** (and run, for the CSP) | Public API URL, e.g. `https://api.example.com`. `NEXT_PUBLIC_*` values are inlined into the browser bundle at **build** time: changing it needs a rebuild. `apps/web/proxy.ts` also reads it to build the CSP `connect-src`; a wrong value makes the browser block every API call. |
| `NEXT_PUBLIC_APP_ENV`         | build                            | `development`/`staging`/`production` label shown in the app. A `staging` or `production` build refuses an `http://` or local API address (a `.test` name is fine for a local rehearsal).                                                                                           |
| `NEXT_PUBLIC_PRIVACY_CONTACT` | build                            | The address shown on the public `/data-deletion` page. Set a real one before launch.                                                                                                                                                                                               |

In the Compose deployment these are **build arguments of the web image** (`NEXT_PUBLIC_API_URL` defaults to `https://api.<DOMAIN>`): change one and rebuild the image (`docker compose build web`).

### mobile (EAS build time)

Set in the profile `env` of `apps/mobile/eas.json`: `APP_VARIANT`, `EXPO_PUBLIC_APP_ENV`, `EXPO_PUBLIC_API_URL`; plus `APP_VERSION`, `EAS_PROJECT_ID`, `APP_WEB_HOST` ([section 11](#11-mobile-release-path)).

## 4. Secrets

**With the Compose deployment, `./deploy/generate-secrets.sh` does all of this** and writes the values into `deploy/.env` (mode 600) without printing them, plus the backup
private key into `deploy/backup-age-identity.txt` (mode 600, to be moved off the host). Both files are git-ignored and excluded from the image build context; the script refuses to overwrite
an existing file without `--force`. It was run and its output checked on 2026-10-21 (13 values generated, none shown, files created with mode 600, the JWT pair accepted by a production API).

For another deployment, generate on a trusted machine, store in the secret manager, never in git, chat or tickets, and never print into CI logs. Examples (output intentionally not shown):

```bash
# JWT signing key pair (Ed25519). Needs the API built first (pnpm build). Prints two lines to the terminal and writes nothing to disk.
pnpm --filter @orderloop/api auth:generate-keys
#   -> JWT_PRIVATE_KEY=...   JWT_PUBLIC_KEY=...   (put both in the secret manager)

# Courier / Meta sealing key: exactly 32 random bytes, base64
openssl rand -base64 32          # -> COURIER_CREDENTIALS_KEY

# Meta webhook verify token (16+ characters)
openssl rand -hex 24             # -> META_WEBHOOK_VERIFY_TOKEN

# Database passwords: hex avoids characters that need URL-encoding inside DATABASE_URL
openssl rand -hex 24             # one per role: app_user, app_migrator, admin
```

- **Cookie and CSRF settings need no secret**: the refresh cookie is `HttpOnly`, `SameSite=Lax`, `Secure` (when `NODE_ENV=production`), host-only on the API host, path `/v1/auth`; the cookie refresh route requires the `x-client: web` header and an allowed `Origin`. There is no CSRF token and no cookie-signing secret.
- Custody and loss behaviour of the keys: [backup-and-restore.md](backup-and-restore.md#3-keys-and-secrets-custody). The sealing key must be backed up **separately from database backups**.
- `META_APP_SECRET` comes from the Meta app dashboard (not generated by you).
- Give each service only what it needs (api: not `DATABASE_ADMIN_URL`/`DATABASE_MIGRATION_URL`; worker: not `JWT_*`).
- The `.env.example` passwords (`app_user_dev`, ...) are development defaults; never use them.

## 5. Database setup and migrations

**In the Compose deployment the `migrate` job does steps 2 and 3 below on every `up`** (roles, then `prisma migrate deploy` as `app_migrator`, then `migrate status`; it creates no `<db>_test` database,
and also creates `app_backup` and `app_monitor`, see [backup-and-restore.md](backup-and-restore.md#the-backup-role)). The rest of this section is for other setups.

1. Provision PostgreSQL 16. Create the three URLs (admin/superuser, `app_migrator`, `app_user`) with strong passwords.
2. **Roles and database** (once per cluster), from a machine with the repository and Node:
   ```bash
   DATABASE_ADMIN_URL=postgresql://<admin>:<pw>@<host>:5432/<db> \
   DATABASE_MIGRATION_URL=postgresql://app_migrator:<pw>@<host>:5432/<db> \
   DATABASE_URL=postgresql://app_user:<pw>@<host>:5432/<db> \
   pnpm db:setup
   ```
   It is idempotent. It creates `app_migrator` (`NOSUPERUSER NOBYPASSRLS CREATEDB`, owns the database and the `public` schema) and `app_user` (`NOSUPERUSER NOBYPASSRLS NOCREATEDB`), takes the role
   passwords from those URLs, closes the database to `PUBLIC`, and sets default privileges. **It also creates a second database named `<db>_test`** (used by the integration tests); on a production
   server drop it afterwards (`DROP DATABASE <db>_test`) unless you want it. It needs a superuser: **on a managed PostgreSQL without superuser access it cannot run as is**; create the equivalent roles and grants by hand following `packages/db/scripts/setup-roles.mjs` (not tested).
3. **Migrations**: `DATABASE_MIGRATION_URL=... pnpm db:migrate:deploy`, then `pnpm --filter @orderloop/db run migrate:status` (`Database schema is up to date!`). Rules and rollback in [migrations.md](migrations.md).
4. `pnpm db:init` = `db:setup` + `db:migrate:deploy` in one go, if you have all three URLs in the environment.
5. **Do not run `pnpm db:seed` in production.** It refuses (production or non-local host), by design.
6. Verify the runtime role is confined: as `app_user`, `SELECT count(*) FROM orders;` returns `0` with no tenant context ([backup-and-restore.md](backup-and-restore.md#6-restore-drill-procedure), step 5).
7. Schedule backups before the first real data ([backup-and-restore.md](backup-and-restore.md)).

## 6. CORS, origins and cookies

- The API allows browser origins only from `WEB_ORIGINS` (exact match), with credentials, methods `GET POST PUT PATCH DELETE`, request headers `authorization`, `content-type`, `x-client`. Native apps are not subject to CORS.
- The web app on `https://app.example.com` and the API on `https://api.example.com` are **same-site**, so the `SameSite=Lax` refresh cookie accompanies the web app's credentialed fetches. **Hosting web and API on different registrable domains (for example `example.com` and `example.net`, or a `*.vercel.app` web host with your own API domain) is not supported by the cookie design as written, and was not tested**: the browser would not send the Lax cookie on those cross-site fetches, so sessions would not survive a reload.
- Cookie `Secure` is tied to `NODE_ENV=production`: terminate TLS in front of the API and never serve the production API over plain HTTP.
- There is no `COOKIE_DOMAIN` setting; the cookie is host-only on the API host.
- Switching business starts a new session; browsers share the one cookie across tabs (see [../known-issues.md](../known-issues.md)).

## 7. Build and start

On a build machine, from a clean checkout of the release tag (this mirrors CI):

```bash
corepack enable && corepack prepare pnpm@11.28.6 --activate
pnpm install --frozen-lockfile
# NEXT_PUBLIC_API_URL and NEXT_PUBLIC_APP_ENV must be set for this step: they are baked into the web bundle.
NEXT_PUBLIC_API_URL=https://api.example.com NEXT_PUBLIC_APP_ENV=production \
  pnpm build --filter='!@orderloop/mobile'
```

`pnpm build` runs `turbo run build`: `prisma generate` + `tsc` for `@orderloop/db` and the packages, `tsc` for api and worker (output `dist/`), `next build` for web.
The mobile app is built separately by EAS. The api and worker import the workspace packages **from their `dist/` output**, so the runtime artifact is the built workspace
(repository checkout with `node_modules` and every `dist/`), not just `apps/api/dist`. The Docker images use `pnpm deploy --prod` to make that artifact lean ([Containers](#containers)); outside Docker, the full built workspace is what was tried.

Start commands (working directory in parentheses; set the environment first):

| Service | Command                                                                          | Notes                                                                     |
| ------- | -------------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| api     | `pnpm --filter @orderloop/api start` (= `node dist/main.js` in `apps/api`)       | Shuts down gracefully on SIGTERM (`enableShutdownHooks`).                 |
| worker  | `pnpm --filter @orderloop/worker start` (= `node dist/main.js` in `apps/worker`) | On SIGTERM/SIGINT finishes the current import, closes queues, exits 0.    |
| web     | `pnpm --filter @orderloop/web start` (= `next start -p 3000`)                    | A different port: `pnpm --filter @orderloop/web exec next start -p 8080`. |

Start order: database + Redis, migrations, **worker and api**, web. Run **one process per role** to begin with:

- **api**: stateless, but the per-IP request limiter and the Meta webhook throttle are **in memory per instance** (limits multiply with replicas) and `docs/api.md` says to use a shared store before running more than one replica. Pilot: one api instance (restart under a supervisor). The lockout counters are in Redis and are shared.
- **worker**: safe to run several (BullMQ distributes jobs; one tick scheduler regardless of count; each process runs one import at a time, automation evaluation concurrency 4, delivery 5, Meta events 4). Add a second worker when queues back up ([incident-response.md](incident-response.md#worker-stuck-or-queue-backlog)).
- **web**: stateless; scale freely. It sets a nonce-based Content-Security-Policy per request (`apps/web/proxy.ts`), so **do not cache HTML responses** at a CDN or proxy (a cached nonce would block the page's own scripts). Static assets under `/_next/static` are safe to cache.

### Illustrative: systemd units (adapt paths, user, secrets; not tested)

```ini
# /etc/systemd/system/orderloop-api.service   (illustrative)
[Unit]
Description=OrderLoop API
After=network-online.target

[Service]
User=orderloop
WorkingDirectory=/srv/orderloop/apps/api
EnvironmentFile=/etc/orderloop/api.env        # mode 0600, root-owned, holds the variables from section 3
ExecStart=/usr/bin/node dist/main.js
Restart=always
RestartSec=3
TimeoutStopSec=30
NoNewPrivileges=true

[Install]
WantedBy=multi-user.target
```

The worker unit is the same with `WorkingDirectory=/srv/orderloop/apps/worker` and its own env file. The web unit runs `/usr/bin/node /srv/orderloop/node_modules/next/dist/bin/next start -p 3000` with `WorkingDirectory=/srv/orderloop/apps/web`
(path of the `next` binary depends on the pnpm layout; check it).

### Containers

The provided `deploy/Dockerfile` has one target per image; see [section 0](#0-quick-start-single-host) for the Compose stack and the file's header for
`docker build` commands. Facts about the images: Node 22 pinned to an exact version (same major as `.nvmrc`, a repository test checks it); pnpm 11.28.6 via
corepack; `pnpm install --frozen-lockfile --filter <app>...` in a layer that depends only on manifests and the lockfile (the `turbo prune` equivalent, justified in the file);
`pnpm deploy --prod` copies each app with its production dependencies only, so the api and worker images contain no dev dependencies, no source and no tests (the
Prisma CLI, which arrives as an automatic peer of the client, is removed from them; the migrate image keeps it because it needs it); web uses Next's standalone
output; all run as the unprivileged `node` user; each has a `HEALTHCHECK`. Approximate sizes on the test machine: api 610 MB, worker 563 MB, migrate 843 MB, web and ops
see the local run in [section 14](#14-what-was-tested-and-what-was-not). Secrets are passed at run time as environment variables, never baked in (`.dockerignore` excludes every `.env`).
**The images are not scanned for vulnerabilities and are not signed**; the base images are the official ones at exact tags, not pinned by digest.

## 8. Health checks

| Check               | Use                                                                                                                                                                                                                                                              |
| ------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /health/live`  | Process supervisor / container liveness. 200 while the process answers.                                                                                                                                                                                          |
| `GET /health/ready` | Readiness and the uptime monitor: 200 only if PostgreSQL **and** Redis answer within 1.5 s each; otherwise 503 with the failing dependency named. Using it for load-balancer routing also removes the API during a Redis-only outage (see the incident runbook). |
| Web                 | `GET /` expecting 200/redirect. No dedicated endpoint.                                                                                                                                                                                                           |
| Worker              | `GET :4010/health/live` and `/health/ready` (Redis, PostgreSQL, heartbeat loop), internal only; the image's `HEALTHCHECK` uses `/health/ready`. Also the `automation.tick` log line every minute. [monitoring.md](monitoring.md#health-endpoints-worker).        |

## 9. Reverse proxy requirements

- **HTTPS only**, valid certificates, HTTP redirected to HTTPS. TLS 1.2+. The API sets HSTS through `helmet`; the web app sets `Strict-Transport-Security` itself in production builds.
- Forward `X-Forwarded-For` and `X-Forwarded-Proto`; set `TRUST_PROXY` to the number of proxies (a CDN in front of a load balancer in front of the API is 2).
- **Do not alter request bodies** on `POST /v1/webhooks/meta` (Meta's signature is over the exact bytes; no compression, rewriting or body buffering that changes them), and do not strip `X-Hub-Signature-256`, `X-PATHAO-SIGNATURE` or `Authorization` on webhook routes. The public webhook paths must be reachable from the internet: `/v1/webhooks/meta`, `/v1/webhooks/meta/deauthorize`, `/v1/webhooks/meta/data-deletion`, `/v1/webhooks/meta/data-deletion/status`, `/v1/webhooks/couriers/...`, `/v1/integrations/meta/oauth/callback` (the browser returns here).
- Body size: API JSON is capped at 100 KB, catalog/order CSV imports at 3 MB, the Meta webhook at 512 KB. Allow at least 3 MB at the proxy.
- Timeouts: courier calls and the API's transactions are bounded by 60 s; set the upstream read timeout to at least 65 s on the API.
- Pass `Origin`, `Cookie`, `Authorization`, `x-client` through unchanged; do not add your own CORS headers (the API sends them).
- No WebSocket support needed. Do not expose Redis or PostgreSQL publicly.
- Do not cache API responses. Do not cache web HTML (nonce CSP).
- The API's `helmet()` headers and the web app's security headers/CSP are set by the applications; do not override the CSP at the proxy. `NEXT_PUBLIC_API_URL`'s origin must equal the API's public origin or the CSP blocks calls.

**The provided [`deploy/Caddyfile`](../../deploy/Caddyfile) implements every point above** (automatic HTTPS and the redirect, forwarded headers for exactly one hop with `TRUST_PROXY=1`, no body rewriting or encoding,
4 MB bodies, a 70 s upstream header timeout, no added CORS or CSP headers, no caching, `/metrics` answered 404). Verified on 2026-10-21 with Caddy's internal CA: HTTPS to both hosts, HTTP redirected with 308,
`/metrics` 404 through the proxy, the app's own HSTS and CSP headers reaching the browser unchanged. **Let's Encrypt issuance, renewal, HTTP-01 reachability and behaviour under real client traffic were not tested.**

Illustrative Nginx server block for the API if you do not use Caddy (adapt; not tested):

```nginx
server {
  listen 443 ssl http2;
  server_name api.example.com;
  # ssl_certificate / ssl_certificate_key ...
  client_max_body_size 4m;
  location / {
    proxy_pass http://127.0.0.1:4000;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_read_timeout 70s;
    proxy_request_buffering on;   # the API reads the body; the Meta webhook body is forwarded unmodified
  }
}
```

With one Nginx in front of the API set `TRUST_PROXY=1`.

## 10. Defaults that matter: push, Meta, couriers, SMS

| Setting                             | Pilot default                    | What it means                                                                                                                                                                                                                                                                                                                                                                                       |
| ----------------------------------- | -------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `PUSH_PROVIDER`                     | `dev` unless Expo push is set up | `dev`: nothing reaches phones, logs a warning in production. `expo`: needs real Expo push tokens, which need an EAS project id and FCM/APNs credentials (section 11). Same value on api and worker.                                                                                                                                                                                                 |
| `META_MODE`                         | `mock` (default)                 | Labelled simulated provider; no Meta account involved; mock connection and event routes exist (**404 in live**). `live` is written against Meta's documentation and **not tested with authorised credentials** ([../meta.md](../meta.md)); until App Review only people with a role on the Meta app can connect. Do not enable it for the pilot without the activation checklist and a named owner. |
| `COURIER_MOCK_ENABLED`              | unset (off in production)        | Real Pathao/Steadfast integrations were **never run against a real account** ([../couriers.md](../couriers.md)). Decide per business whether the pilot uses a simulated courier, a sandbox, or manual booking.                                                                                                                                                                                      |
| `SMS_PROVIDER`, `WHATSAPP_PROVIDER` | `none`                           | No vendor is integrated; SMS/WhatsApp cannot send. `console` only logs.                                                                                                                                                                                                                                                                                                                             |
| `MAIL_PROVIDER`                     | `smtp`                           | Required in production.                                                                                                                                                                                                                                                                                                                                                                             |

### Email setup: SPF, DKIM, DMARC and a test send

OrderLoop sends account mail (verification, password reset, invitations) and notification email through the SMTP account in `MAIL_PROVIDER=smtp`. It refuses `console` in production and requires STARTTLS
(or `SMTP_SECURE=true`) with a trusted certificate. **None of the following was done or tested against a real provider by the project**; it is the setup a pilot needs before the first real email.

1. **Pick a provider** that supports SMTP and a verified sending domain (any of Postmark, Amazon SES, SendGrid, Mailgun, Resend via SMTP; none is integrated beyond SMTP). Use a dedicated sending address such as `no-reply@mail.<your domain>`; put it in `MAIL_FROM`.
2. **SPF** (who may send for the domain): publish **one** TXT record at the sending domain, as the provider tells you, for example `v=spf1 include:<provider's include> -all`. Two SPF records, or more than 10 DNS lookups, break it.
3. **DKIM** (a signature the receiver can check): publish the CNAME or TXT records the provider gives you (a selector under `_domainkey`), then wait for the provider to show the domain as verified.
4. **DMARC** (what to do when SPF/DKIM fail or do not align with the `From:` domain): start with `_dmarc.<domain>  TXT  "v=DMARC1; p=none; rua=mailto:dmarc-reports@<domain>"`, read the reports for two to four weeks, then move to `p=quarantine` and later `p=reject`. The `From:` domain must align with the DKIM (or SPF) domain, otherwise DMARC fails even when both pass.
5. **Bounces and complaints** arrive in the provider's console, not in OrderLoop: someone must read them, and remove addresses that bounce.
6. **Test send**, from the running API (never from a laptop with production credentials):

   ```bash
   docker compose -f deploy/docker-compose.yml exec api node dist/scripts/mail-test.js --to you@example.com
   # from a checkout, with the same environment variables:  pnpm mail:test -- --to you@example.com [--subject "..."]
   ```

   It sends one real message through the same transport settings the API uses and prints, without any secret: the provider (`smtp` or `console`), host, port, whether TLS is required, the server's greeting, the TLS version and cipher, whether the certificate
   is trusted and when it expires, the capabilities offered (STARTTLS, AUTH mechanisms, maximum size), the server's final reply (queue id) and warnings (unencrypted connection, untrusted certificate, no credentials). It exits **non-zero** on failure with the reason
   (credentials, host and `password=` values are redacted from errors), `2` for a bad argument or environment, and with `MAIL_PROVIDER=console` it only prints and says nothing was sent. The `--to` address is the only thing it needs.
   **Not run against any real mail provider.** It was run against a local test mail server offering STARTTLS with a private CA (see [section 14](#14-what-was-tested-and-what-was-not)) and against a local Mailpit without TLS.

**Deliverability checklist** (tick each against a real send; nothing here has been ticked by the project):

- [ ] SPF, DKIM and DMARC records published; the provider shows the domain verified.
- [ ] `mail:test` to a Gmail and an Outlook address lands in the **inbox**, not spam. In the message source (Gmail "Show original"), `spf=pass`, `dkim=pass` and `dmarc=pass` all appear, and the domain in `From:` is the one that passes.
- [ ] A real **verification email** (sign up with an allowlisted address) and a **password-reset email** arrive and their links open the web app on the right host over https.
- [ ] The `From:` name and address look like the product; replies go somewhere read (or `no-reply` is stated in the text).
- [ ] The provider's bounce and complaint reports are routed to a named person; the DMARC report address is read.
- [ ] Port 587 (or 465) is reachable from the host (some clouds block outbound SMTP until asked); the certificate chain is trusted (`mail:test` says so).
- [ ] The sending volume of the pilot is far under the provider's limits; a new domain is warmed up gradually rather than used at full volume on day one.

### Verify a courier with real credentials (first contact)

`pnpm courier:verify -- --provider pathao|steadfast` runs the **read-only** operations of the courier adapters against a real account and prints a pass/fail table. It was written because the project never ran the integrations against Pathao or Steadfast
([../couriers.md](../couriers.md)). **It has NOT been run against a real or sandbox account; its unit tests use fakes.** It books nothing and cancels nothing: the command refuses `--book`, `--cancel`, `--create`, `--delete` and `--send`, and it works through a view of the adapter that
has no `book` or `cancel` at all.

Credentials come **only from environment variables**, for that one command, never from arguments (`--client-secret`, `--password`, `--api-key`, `--secret-key` and `--token` are refused), never from `.env`, and nothing is stored:

| Provider  | Required variables                                                        | Optional                                                                   | Arguments                                                                                                                                                                                                                          |
| --------- | ------------------------------------------------------------------------- | -------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Pathao    | `COURIER_VERIFY_PATHAO_CLIENT_ID`, `COURIER_VERIFY_PATHAO_CLIENT_SECRET`  | `COURIER_VERIFY_PATHAO_USERNAME` + `COURIER_VERIFY_PATHAO_PASSWORD` (both) | `--environment sandbox` (default) or `production` (your real account, still read-only), `--consignment <id>` (tracking lookup of an existing parcel), `--city-id`, `--zone-id`, `--store-id` (otherwise the first of each is used) |
| Steadfast | `COURIER_VERIFY_STEADFAST_API_KEY`, `COURIER_VERIFY_STEADFAST_SECRET_KEY` |                                                                            | `--host steadfast` (default) or `packzy`, `--consignment <id>`, `--reference <invoice>` (lookup by our own reference)                                                                                                              |

```bash
COURIER_VERIFY_PATHAO_CLIENT_ID=... COURIER_VERIFY_PATHAO_CLIENT_SECRET=... \
  pnpm courier:verify -- --provider pathao --environment sandbox --consignment DL123456
```

Checks, Pathao: sign-in/token and store list (store ids are printed, names are not), city lookup, zone lookup, area lookup, a price quote (a fixed fictitious parcel; nothing is booked), tracking lookup of a supplied consignment. Steadfast: the balance call
(the balance itself is not printed), tracking of a supplied consignment, lookup by a supplied invoice; the courier's other operations do not exist and are shown as `N/A`. Each row is `PASS`, `FAIL` (exit code 1), `SKIP` (an argument it needs was not given) or `N/A`.
Everything printed passes through a redactor that replaces the exact credential values, bearer tokens, token-shaped strings, email addresses and Bangladeshi phone numbers. A passing run shows the SDK's _assumptions_ hold for that account (the Pathao price and
order-info endpoints are only documented by a community SDK, see the sources table in [../couriers.md](../couriers.md)); it does not prove booking works, and booking is never attempted.

## 11. Mobile release path

**Not published anywhere.** No store listing, no TestFlight or Play track, no signing credentials exist in this repository. CI only proves the bundles build and a native project can be generated
(`expo export`, `expo prebuild`). Physical devices, release builds, tablets, VoiceOver and TalkBack are **not tested** ([../known-issues.md](../known-issues.md)).

1. `apps/mobile/eas.json` profiles: `development` (dev client, internal, simulator/APK), `preview` (internal distribution, APK; `APP_VARIANT=preview`), `production` (app-bundle, `autoIncrement`, `APP_VARIANT=production`). `appVersionSource` is `remote`.
   **Replace the placeholder `EXPO_PUBLIC_API_URL` values (`https://api.staging.example.com`, `https://api.example.com`)** with your real API; for `preview` and `production`, `app.config.ts` throws if the URL still contains `example.com`. A cloud build with no `APP_VARIANT` stops with an error.
2. Identifiers (`apps/mobile/app.config.ts`): production `com.orderloop.app` (iOS bundle id and Android package), preview `com.orderloop.app.preview`, development `com.orderloop.app.dev`; URL schemes `orderloop`, `orderloop-preview`, `orderloop-dev`. They must match the App ID in your Apple account and the Play app; change them before the first store build if they are not yours.
3. `eas init` creates the Expo project; set `EAS_PROJECT_ID` (needed for push tokens), `APP_VERSION`. `eas build --profile preview --platform all` first, tested by pilot users on real devices; then `--profile production`.
4. **Push**: needs `EAS_PROJECT_ID`, Firebase (FCM) credentials for Android and an Apple push key for iOS in the EAS project, and `PUSH_PROVIDER=expo` on the server. Expo Go cannot receive push; simulators neither. **Never tested on a real device from this repository.**
5. **Email links opening the app** (optional): `APP_WEB_HOST` plus the `apple-app-site-association` and `assetlinks.json` files on the web host ([../mobile.md](../mobile.md)). Without it, links open in the browser.
6. **Store requirements to prepare (not done, none claimed)**: a privacy policy URL; Apple App Privacy answers and Google Play Data safety answers describing what the app handles (account email and name, business and customer order data entered by users, push token, no location, camera or contacts; Android permissions are limited to `INTERNET`, `ACCESS_NETWORK_STATE`, `VIBRATE`); screenshots, descriptions, support URL, age rating; Apple review demo credentials (a demo business; `pnpm db:seed` data is local-only) and review notes.
   **Account deletion**: the app has no in-app way to delete an account or business and the API has no such endpoint. Check Apple's and Google's current account-deletion requirements for apps that allow account creation; this is likely a store-approval blocker ([../release/known-limitations.md](../release/known-limitations.md)).
7. The API must stay backwards compatible with every app version in the field; a store build cannot be rolled back.

## 12. Smoke test after deploy

Use a dedicated pilot test business, not a real seller's. Check each and record the result. `./deploy/smoke-test.sh` automates items 1, 3 (headers), 4 (sign-up, with the verification email read from the test mail server),
5 (a product only), 9 (webhook routes were not probed) partly and the production safeguards, against a throwaway stack: its output is the evidence quoted in [section 14](#14-what-was-tested-and-what-was-not).

1. `curl -i https://api.example.com/health/live` is 200; `/health/ready` is 200 with `postgres` and `redis` `up`.
2. The API log shows `request completed` lines as JSON; the worker log shows `[worker] ready ...`, `automation ready` and `Meta ready (mock|live)`, and `automation.tick` every minute.
3. Web: `https://app.example.com` loads, response headers include the CSP and HSTS, the browser console shows no CSP or CORS errors.
4. Register or sign in as the test user; the verification email **arrives through SMTP** (not in a log) and its link opens the web app; sign out and in again; reload the page and the session persists (cookie works).
5. Create a product with stock, create an order, confirm it (stock reserved), move it to ready to ship.
6. With a simulated courier (if enabled for the test business) book a shipment and follow it to delivered; or confirm booking is intentionally unavailable.
7. Upload a small catalog CSV: it reaches `COMPLETED` (proves the worker and Redis).
8. Trigger a notification (low stock rule) and see it in the app; if `PUSH_PROVIDER=expo`, on a real device see the push.
9. Webhook reachability: `curl -i https://api.example.com/v1/webhooks/meta` is not a connection error (a 4xx is expected without a valid verify handshake); a request with no signature to a webhook route is `401`, not `5xx`.
10. As `app_user`, with no tenant context, tables return zero rows (isolation holds in this database).
11. `migrate:status` is up to date; `COURIER_CREDENTIALS_KEY` correct (a courier connection test either works or says plainly it cannot decrypt).
12. Mobile (when applicable): the build installs, signs in against the production API and shows the same data as the web.

## 13. Rollback

- **Application**: check out the previous release tag and `docker compose build && docker compose up -d` (images are built locally from the tag; set `IMAGE_TAG` to keep the previous images next to the new ones so you can switch without rebuilding). The migrate job re-runs and is a no-op if the schema is unchanged. Roll web and api together when the API contract changed. **A rollback of a running system was not rehearsed.**
- **Schema**: leave it if the migration was additive; otherwise fix forward or restore ([migrations.md](migrations.md#rollback-strategy)).
- **Configuration/secrets**: keep the previous values until the new ones are proven; a key rotation is not instantly reversible (sealed secrets, sessions).
- **Mobile**: cannot be rolled back; stop the rollout in the store console and keep the API compatible.
- Decision criteria and the runbook: [incident-response.md](incident-response.md#bad-deploy-rollback), [../release/pilot-checklist.md](../release/pilot-checklist.md#6-rollback-criteria).

### Production sign-up policy

`REGISTRATION_MODE` has **no default in production**: with `NODE_ENV=production` and the variable unset, the API refuses to start with `REGISTRATION_MODE must be set explicitly in production (allowlist for a pilot, open to let anyone sign up)`.
Outside production the default stays `open`. Choose on purpose:

```
REGISTRATION_MODE=allowlist
REGISTRATION_ALLOWED_EMAILS=owner@seller.example,@pilot-company.example
```

- Entries are exact emails and/or `@domain.com` (whole domain, not subdomains), case-insensitive; the list is required when the mode is `allowlist` and the API refuses to start without it (restart the API to change it).
- `POST /v1/auth/register` for any other email is `403 registration_closed` (the message does not reveal the list; the password is still hashed first, so timing does not tell listed from unlisted). Listed emails, sign-in, verification, password reset and **accepting an invitation** are unchanged: a business owner or admin can still invite anyone into their own business.
- Check after deploy: register with a non-listed address and expect `registration_closed`; register with a listed one and expect success (done by `deploy/smoke-test.sh`). Set to `open` to let anyone sign up.

## 14. What was tested and what was not

Run on 2026-10-21 on one developer laptop (macOS, Docker Desktop 29.9, arm64), with `./deploy/smoke-test.sh` under the throwaway project `orderloop-smoke` on ports 18080/18443 (the developer's own `orderloop-*` containers and ports were not touched; `docker compose down -v` was run for that project only).

| Check                                                                                                               | Result                                                                                                                 |
| ------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `docker build` of `api`, `worker`, `migrate`, `web`, `ops` from a clean context                                     | all built (first full build about 1 minute for the three server targets, web about 40 s)                               |
| `docker compose config` with `deploy/.env.example`, with and without the `monitoring` and `ops` profiles            | valid                                                                                                                  |
| Migrate job on an empty PostgreSQL 16.15                                                                            | roles created, 23 migrations applied, `Database schema is up to date!`, exit 0                                         |
| api, worker, web, backup, redis, postgres, caddy healthchecks                                                       | healthy                                                                                                                |
| `NODE_ENV=production` start-up safeguards                                                                           | the first attempt exposed that the worker demanded the API's JWT keys: fixed (worker validates without API-only rules) |
| `GET https://api.orderloop.test:18443/health/ready` through Caddy (internal CA)                                     | 200 `{"status":"ok","checks":{"postgres":"up","redis":"up"}}`                                                          |
| HTTP to HTTPS                                                                                                       | 308                                                                                                                    |
| `/metrics` through the public proxy                                                                                 | 404                                                                                                                    |
| `/metrics` on the API: no token, wrong token, right token                                                           | 401, 401, 200                                                                                                          |
| Worker `/health/ready`, `/metrics` without and with the token                                                       | 200 with `redis`, `postgres`, `heartbeat` up; 401; 200                                                                 |
| Sign-up with a non-allowlisted email / an allowlisted email                                                         | 403 `registration_closed` / 201                                                                                        |
| Create a product (`POST /v1/products`) and a second business with its own product                                   | 201; each business sees only its own products                                                                          |
| Verification email through a test mail server that offers STARTTLS with a private CA (production requires STARTTLS) | delivered; `mail:test` printed TLS 1.3, trusted certificate, server banner                                             |
| api, worker, web: user, root filesystem, capabilities                                                               | `node`, read-only, all dropped                                                                                         |
| Published ports                                                                                                     | only Caddy's                                                                                                           |
| Backup, drill and failure cases                                                                                     | [backup-and-restore.md](backup-and-restore.md#drill-performed-on-2026-10-21-local)                                     |
| Monitoring profile and a live alert                                                                                 | [monitoring.md](monitoring.md#alert-test-performed-on-2026-10-21-local)                                                |

**Not tested:** a real host or domain; Let's Encrypt; a real SMTP provider (SPF/DKIM/DMARC, deliverability, spam folder); Linux; load; an upgrade or rollback of a stack holding data; off-site upload
(`rclone` to a real S3-compatible bucket); two API replicas; the images under a vulnerability scanner; the web app in a browser from the deployed stack (the page answered 200 with its security headers;
no script ran); Kubernetes, Terraform or any managed-cloud setup (none provided); the mobile app against the deployed API.
