# Deployment guide (production / pilot)

How to run OrderLoop outside a laptop. **The repository provides no Dockerfile, no production compose file, no Kubernetes or
Terraform, and no deployment workflow**: `infra/docker-compose.yml` is for local PostgreSQL, Redis and Mailpit only, and
`.github/workflows/ci.yml` builds and tests but does not deploy. So deployment images are **not provided**; this guide describes a
generic container or VM deployment using the repository's own commands. Every snippet marked _illustrative_ is an example to adapt,
**not tested** by the project.

Related: [migrations.md](migrations.md), [backup-and-restore.md](backup-and-restore.md), [monitoring.md](monitoring.md),
[incident-response.md](incident-response.md), [../release/pilot-checklist.md](../release/pilot-checklist.md).

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
                                                                    └───────────── worker (BullMQ, no HTTP) ┘
 api and worker ──► SMTP provider, Expo push service (optional), Meta Graph API (live mode), courier APIs
```

| Component         | Process                                                       | State                            | Notes                                                                                                                                         |
| ----------------- | ------------------------------------------------------------- | -------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| **api**           | `node apps/api/dist/main.js`                                  | none (all in PostgreSQL / Redis) | REST API, public webhooks, the only thing browsers and phones call. Serves no HTML. `/api-docs` is **not** served when `NODE_ENV=production`. |
| **worker**        | `node apps/worker/dist/main.js`                               | none                             | No HTTP port. Imports, automation, notification delivery, Meta event processing, sweepers, retention. Needs the same env as the API.          |
| **web**           | `next start -p 3000` in `apps/web`                            | none                             | Thin Next.js shell over the shared screens. The browser talks to the API directly (cross-origin).                                             |
| **mobile**        | Built with EAS, installed from stores / internal distribution | on device                        | Not a server. Points at one API URL fixed at build time.                                                                                      |
| **PostgreSQL**    | 16                                                            | all business data                | Roles `app_migrator` (owner) and `app_user` (runtime), forced RLS. Backups: [backup-and-restore.md](backup-and-restore.md).                   |
| **Redis**         | 7                                                             | queues and lockout counters only | Not durable by design. Password + TLS (`rediss://`) if networked.                                                                             |
| **SMTP**          | any provider                                                  | none                             | Verification, password reset, invitations, notification email.                                                                                |
| **Reverse proxy** | Nginx, Caddy, a cloud load balancer, ...                      | none                             | TLS termination, HTTPS only.                                                                                                                  |

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
value stops the process with every problem listed (values are not echoed). Variables already in the process environment win over a
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

### api only

| Variable                            | Required                                             | Notes                                                                                                                                                                        |
| ----------------------------------- | ---------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `API_PORT`                          | no (`4000`)                                          | Listen port.                                                                                                                                                                 |
| `JWT_PRIVATE_KEY`, `JWT_PUBLIC_KEY` | **yes in production**, both or neither               | Base64 PEM of an Ed25519 key pair. Without them development generates an ephemeral key; production refuses to start.                                                         |
| `ACCESS_TOKEN_TTL_SECONDS`          | no (`900`)                                           | 60 to 3600.                                                                                                                                                                  |
| `REFRESH_TOKEN_TTL_DAYS`            | no (`30`)                                            | 1 to 90.                                                                                                                                                                     |
| `REFRESH_REUSE_GRACE_SECONDS`       | no (`10`)                                            | 0 to 60; 0 turns the retry grace off.                                                                                                                                        |
| `WEB_ORIGINS`                       | yes in practice (default is `http://localhost:3000`) | Comma-separated exact browser origins allowed with credentials, e.g. `https://app.example.com`. No path, no trailing slash. The first one is also where emailed links point. |
| `WEB_APP_URL`                       | no                                                   | Where the Meta sign-in returns to (default: first `WEB_ORIGINS`).                                                                                                            |
| `TRUST_PROXY`                       | no (`0`), **set it**                                 | Exact number of reverse-proxy hops in front of the API (0 to 5). Wrong values break per-IP rate limits and make the logged IP spoofable or the same for everyone.            |
| `API_PUBLIC_URL`                    | yes for webhooks                                     | Public `https://` address of the API; shown to sellers as the webhook address; **must be https in production** or the API refuses to start.                                  |
| `COURIER_MOCK_ENABLED`              | no                                                   | The simulated courier: on by default outside production; in production it is off unless set to `true`. Leave off unless the pilot deliberately uses it.                      |
| `RATE_LIMIT_ENABLED`                | no (`true`)                                          | `false` is for automated tests only. Never in production.                                                                                                                    |

### worker only

The worker has no variables of its own: it reads the shared set above (`DATABASE_URL`, `REDIS_URL`, `MAIL_*`/`SMTP_*`, `PUSH_*`, `SMS_*`, `WHATSAPP_*`, `COURIER_CREDENTIALS_*`, `META_*`, `LOG_LEVEL`). It does not read `JWT_*`, `WEB_ORIGINS` or `TRUST_PROXY`, but giving it the full set is harmless. It needs outbound access to Redis, PostgreSQL, SMTP, `exp.host` (if `expo`) and the Graph API (if `live`).

### Migration and setup tooling only (not runtime)

| Variable                 | Used by                                    | Notes                                                                |
| ------------------------ | ------------------------------------------ | -------------------------------------------------------------------- |
| `DATABASE_MIGRATION_URL` | `pnpm db:migrate:deploy`, `migrate:status` | URL of **`app_migrator`** (table owner). Not given to api or worker. |
| `DATABASE_ADMIN_URL`     | `pnpm db:setup` only                       | Superuser URL. **Not** given to any running service.                 |

### web (build time and run time)

| Variable              | When                             | Notes                                                                                                                                                                                                                                                                              |
| --------------------- | -------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `NEXT_PUBLIC_API_URL` | **build** (and run, for the CSP) | Public API URL, e.g. `https://api.example.com`. `NEXT_PUBLIC_*` values are inlined into the browser bundle at **build** time: changing it needs a rebuild. `apps/web/proxy.ts` also reads it to build the CSP `connect-src`; a wrong value makes the browser block every API call. |
| `NEXT_PUBLIC_APP_ENV` | build                            | `development`/`staging`/`production` label shown in the app.                                                                                                                                                                                                                       |

### mobile (EAS build time)

Set in the profile `env` of `apps/mobile/eas.json`: `APP_VARIANT`, `EXPO_PUBLIC_APP_ENV`, `EXPO_PUBLIC_API_URL`; plus `APP_VERSION`, `EAS_PROJECT_ID`, `APP_WEB_HOST` ([section 11](#11-mobile-release-path)).

## 4. Secrets

Generate on a trusted machine, store in the secret manager, never in git, chat or tickets, and never print into CI logs. Examples (output intentionally not shown):

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
(repository checkout with `node_modules` and every `dist/`), not just `apps/api/dist`. A leaner artifact (`pnpm deploy`, bundling) is not provided and not tested.

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

### Illustrative: containers

No image exists. If you containerise, build one image from the built workspace (Node 22), run it three times with different commands (the table above), pass secrets as runtime environment (not baked into the image), run as a non-root user, and set a `HEALTHCHECK` against `/health/live` for the api. The worker has no HTTP port to check; supervise the process and alert on the missing `automation.tick` log line ([monitoring.md](monitoring.md)). Do not reuse `infra/docker-compose.yml` for production: it uses development passwords and exposes ports on the host.

## 8. Health checks

| Check               | Use                                                                                                                                                                                                                                                              |
| ------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /health/live`  | Process supervisor / container liveness. 200 while the process answers.                                                                                                                                                                                          |
| `GET /health/ready` | Readiness and the uptime monitor: 200 only if PostgreSQL **and** Redis answer within 1.5 s each; otherwise 503 with the failing dependency named. Using it for load-balancer routing also removes the API during a Redis-only outage (see the incident runbook). |
| Web                 | `GET /` expecting 200/redirect. No dedicated endpoint.                                                                                                                                                                                                           |
| Worker              | No endpoint. Process supervisor plus the `automation.tick` log line every minute.                                                                                                                                                                                |

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

Illustrative Nginx server block for the API (adapt; not tested):

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

Use a dedicated pilot test business, not a real seller's. Check each and record the result.

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

- **Application**: redeploy the previous release tag for api, worker and web (build artifacts per tag are not retained by any tooling here: keep them). Roll web and api together when the API contract changed.
- **Schema**: leave it if the migration was additive; otherwise fix forward or restore ([migrations.md](migrations.md#rollback-strategy)).
- **Configuration/secrets**: keep the previous values until the new ones are proven; a key rotation is not instantly reversible (sealed secrets, sessions).
- **Mobile**: cannot be rolled back; stop the rollout in the store console and keep the API compatible.
- Decision criteria and the runbook: [incident-response.md](incident-response.md#bad-deploy-rollback), [../release/pilot-checklist.md](../release/pilot-checklist.md#rollback-criteria).

### Pilot: restrict sign-up

By default anyone who reaches the sign-up screen can create a business. For a pilot, restrict it on the API:

```
REGISTRATION_MODE=allowlist
REGISTRATION_ALLOWED_EMAILS=owner@seller.example,@pilot-company.example
```

- Entries are exact emails and/or `@domain.com` (whole domain, not subdomains), case-insensitive; the list is required when the mode is `allowlist` and the API refuses to start without it (restart the API to change it).
- `POST /v1/auth/register` for any other email is `403 registration_closed` (the message does not reveal the list; the password is still hashed first, so timing does not tell listed from unlisted). Listed emails, sign-in, verification, password reset and **accepting an invitation** are unchanged: a business owner or admin can still invite anyone into their own business.
- Check after deploy: register with a non-listed address and expect `registration_closed`; register with a listed one and expect success. Set back to `open` (or unset) to reopen sign-up.
