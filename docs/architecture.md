# Architecture Decisions

Status: **PROPOSED — awaiting approval.** Nothing here is implemented yet.
Date: 2026-10-15. Versions were checked against the npm registry and the Expo SDK 57 manifest on this date.

Product: **OrderLoop** (Bangladesh-first SaaS for Facebook/Instagram sellers). npm scope `@orderloop/*`. Local services run in Docker.

---

## 1. Repository findings (baseline)

| Item            | Finding                                                                                                                           |
| --------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| Contents        | `README.md` only (2 lines, "OrderLoop… One loop. Every order."). No code, config, CI, or lockfiles.                               |
| Git             | Branch `main`, 1 commit (`5594478 Initial commit`), remote `origin` = `github.com/Shahriar-shaown/OrderLoop`. Working tree clean. |
| Conventions     | None exist yet, so we define them.                                                                                                |
| Local toolchain | Node 22.19.0, npm 10.9.3, corepack, git 2.50, PostgreSQL 16.15 (Homebrew). **Missing:** pnpm, Docker, Redis.                      |

Consequence: the repo is greenfield. Redis is required for BullMQ; it will run in Docker (Docker Desktop is not yet installed locally).

---

## 2. Version decisions

| Component        | Pin                                                                                            | Why                                                                                                                                                                                                                                     |
| ---------------- | ---------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Node.js          | **22 LTS** (22.19+)                                                                            | Satisfies Next (>=20.9), Nest (>=20), Prisma 7 (`^20.19 \|\| ^22.12 \|\| >=24`), turbo. Already installed.                                                                                                                              |
| Package manager  | **pnpm 11.x** via corepack (`packageManager` field)                                            | Best monorepo support. pnpm 12 is the newest tag; 11.28.x is chosen as the more settled line. Approval item D5.                                                                                                                         |
| Monorepo runner  | **Turborepo 2.x**                                                                              | Task graph and caching.                                                                                                                                                                                                                 |
| TypeScript       | **6.0.3**                                                                                      | `typescript@latest` is 7.0.2, a new major (native compiler) that is a risk for NestJS decorator metadata, Prisma generation, and Expo/Metro tooling. 6.0.x is the conservative choice; revisit 7 in a later spike.                      |
| React            | **19.2.3 everywhere (exact)**                                                                  | **Critical:** Expo SDK 57 bundles `react 19.2.3` / `react-native 0.86.3`. `react@latest` is 19.3.1, but a single React version must be shared across the workspace or Metro/React Native renderer mismatches occur. Web follows mobile. |
| Web              | **Next.js 16.4.x** (App Router)                                                                | Peer React `^19`, so 19.2.3 is fine.                                                                                                                                                                                                    |
| Mobile           | **Expo SDK 57** (`expo ~57.0.x`), React Native **0.86.3** (as bundled), `expo-router ~57.0.27` | Use the versions from `bundledNativeModules.json`, not `npm latest` (RN latest is 0.88, which is _not_ SDK 57-compatible). Always install with `npx expo install`.                                                                      |
| API              | **NestJS 12.x** (`@nestjs/*` ^12) with the Express adapter                                     | Node >=20. **Nest 12 packages are ESM-only**, so `api`, `worker` and `contracts` are ESM (`"type": "module"`, `module: NodeNext`, relative imports use `.js`). Fastify adapter is a later optimisation.                                 |
| ORM              | **Prisma 7.10.0** (`prisma` CLI and `@prisma/client` both pinned to `7.10.0`)                  | `prisma@latest` currently points to `8.0.0-rc.23`, a release candidate. Do not use it. Pin CLI and client to the same stable version. Uses driver adapter `@prisma/adapter-pg`.                                                         |
| DB               | **PostgreSQL 16** (local already 16.15)                                                        | RLS, partial indexes, `pg_trgm`.                                                                                                                                                                                                        |
| Queue            | **BullMQ 6.x** + **Redis 7+**                                                                  | BullMQ 6 treats `ioredis` (>=5) as a peer dependency, so apps depend on `ioredis@^5` explicitly.                                                                                                                                        |
| Validation       | **Zod 4** shared via `packages/contracts`                                                      | One schema source for API, web, mobile.                                                                                                                                                                                                 |
| Styling (web)    | Tailwind CSS 4 + shadcn/ui                                                                     |                                                                                                                                                                                                                                         |
| Styling (mobile) | NativeWind or plain StyleSheet (decide in Phase 7)                                             | NativeWind compat with Expo 57 must be verified first.                                                                                                                                                                                  |
| Unit tests       | **Vitest** (shared packages, web), **Jest** only where the Expo/Nest preset requires it        |                                                                                                                                                                                                                                         |
| E2E              | Playwright (web), Supertest (API), Maestro later (mobile)                                      |                                                                                                                                                                                                                                         |
| Lint/format      | ESLint 10 flat config + Prettier                                                               |                                                                                                                                                                                                                                         |

Rule: **versions are pinned exactly** in the root `package.json` `pnpm.overrides` for `react`, `react-dom`, `typescript`, `zod`, `prisma`, `@prisma/client`. A CI check (`pnpm check:versions`) fails on drift.

---

## 3. Application boundaries

```
apps/
  api      NestJS REST API. Owns business logic, auth, DB access. The only writer to Postgres.
  worker   NestJS standalone app (no HTTP). BullMQ processors: courier sync, webhooks, reconciliation, reports.
  web      Next.js dashboard. UI only. Talks to api over HTTP via the generated client. No direct DB.
  mobile   Expo app. UI only. Same API client.
packages/
  contracts     Zod schemas + inferred TS types + enums + error codes. The API/client contract.
  api-client    Typed fetch client generated from the API's OpenAPI spec (+ contracts). Used by web and mobile.
  db            Prisma schema, migrations, generated client, tenant-scoping extension, seed. Imported by api and worker only.
  domain        Pure TS business rules, no I/O: order state machine, COD math, inventory math, phone/address normalisation, money. Heavily unit-tested.
  courier-sdk   CourierAdapter interface + adapters (mock first; Pathao/Steadfast/RedX/Paperfly later).
  config        Shared tsconfig, ESLint, Prettier presets. Env validation helper (zod).
  ui-tokens     (optional, later) Design tokens shared by web and mobile.
infra/        docker-compose.yml, CI workflows, env examples
docs/
```

Dependency rules (enforced with ESLint `no-restricted-imports` / `dependency-cruiser`):

- `web` and `mobile` may import: `contracts`, `api-client`, `domain` (pure helpers only). **Never** `db`.
- `api` and `worker` may import: `db`, `contracts`, `domain`, `courier-sdk`.
- `domain` imports nothing from the workspace except `contracts` enums.
- `contracts` imports nothing from the workspace.
- `api` and `worker` do not import each other. Shared logic goes into a package.

Why a separate `worker` process: courier polling and reconciliation must not share a process (or failure domain) with request handling, and it can scale independently.

---

## 4. Authentication

- **Identity:** `User` (global, one per person). Login by email or BD mobile number (E.164 `+8801XXXXXXXXX`) + password. Password hashing **argon2id**. OTP login/verification by SMS is added when an SMS provider is available (Phase 1 ships with a pluggable `OtpSender` and a console sender for dev).
- **Tokens:**
  - Access token: JWT, 15 min, claims `sub`, `tid` (active tenant), `role`, `sid` (session id). Signed with an asymmetric key (EdDSA) to allow future key rotation (`kid`).
  - Refresh token: opaque 256-bit random, stored **hashed** in `Session`, rotated on every use, with **reuse detection** (replay of a used token revokes the whole session family).
- **Web:** refresh token in an `HttpOnly; Secure; SameSite=Lax` cookie scoped to the API; access token held in memory only. CSRF mitigation: refresh endpoint requires a custom header and checks `Origin`.
- **Mobile:** refresh token in `expo-secure-store` (Keychain/Keystore); access token in memory.
- **Authorization:** `Membership(user, tenant, role)` with roles `OWNER, ADMIN, MANAGER, STAFF, ACCOUNTANT`. A permission map (`domain`) maps role to permissions; controllers use `@RequirePermission('orders:write')`. Membership is re-checked against the DB (short TTL Redis cache) so revocation takes effect within a minute, not at token expiry.
- **Switching tenants:** `POST /v1/auth/switch-tenant` issues a new access token for another tenant the user belongs to.
- **Abuse controls:** `@nestjs/throttler` on auth routes, lockout/backoff on repeated failures, audit log for login, role change, and token reuse events.

## 5. Tenant isolation

Model: **shared database, shared schema, `tenant_id` on every tenant-owned row**, with **three layers**:

1. **Application layer.** A `TenantContext` (AsyncLocalStorage) is populated from the verified JWT + membership. Repositories receive only a tenant-scoped Prisma client; there is no way to obtain the unscoped client in feature modules.
2. **Prisma extension.** A client extension wraps every operation in a transaction that runs `SELECT set_config('app.tenant_id', $1, true)` first and injects `tenantId` into `where`/`data` for tenant models. Unscoped access is limited to a named `systemClient` used only by auth bootstrap and migrations.
3. **PostgreSQL Row-Level Security.** `ENABLE` and `FORCE ROW LEVEL SECURITY` on every tenant table with policy `tenant_id = current_setting('app.tenant_id')::uuid`. The application connects as role `app_user` (no `BYPASSRLS`, not table owner). Migrations run as a separate `app_migrator` role. This makes a forgotten `where` clause fail closed rather than leak.

Additional rules:

- Composite foreign keys `(tenant_id, id)` so a child can never reference another tenant's parent.
- Unique constraints are always tenant-scoped (e.g. `(tenant_id, sku)`, `(tenant_id, order_number)`).
- Background jobs carry `tenantId` in the payload and run inside `TenantContext`; a job without one is rejected.
- Cache and queue keys are prefixed `t:{tenantId}:`.
- **Mandatory test suite** (`tenant-isolation.e2e`): for every tenant table and every endpoint, tenant A cannot read, update, delete, or list tenant B's data, and a query with the tenant setting unset returns zero rows. New tables fail CI if they lack RLS (a schema-introspection test).

## 6. Database design principles

- UUIDv7 primary keys (time-ordered; generated in the app). Human-facing sequences per tenant (`order_number`) via a counter table with row lock.
- **Money:** integer **paisa** (1 BDT = 100 paisa), never floats. Column suffix `_minor`. Aggregates are computed in SQL as `bigint`.
- Timestamps `timestamptz` in UTC; display in `Asia/Dhaka`.
- Soft delete (`deleted_at`) for customer-facing entities; **append-only ledgers** for `stock_movement`, `cod_ledger_entry`, `order_event`, `audit_log`.
- **Inventory** is a movement ledger (receive, reserve, release, ship, return, adjust); on-hand and available are derived or materialised from it, and reservations are taken with `SELECT … FOR UPDATE` on the stock row to prevent overselling.
- **Orders** follow an explicit state machine defined in `packages/domain` (`DRAFT → CONFIRMED → PACKED → HANDED_OVER → IN_TRANSIT → DELIVERED | RETURNED | CANCELLED`, plus partial delivery and exchange). Every transition writes an `order_event`. Illegal transitions are impossible from the API.
- **COD reconciliation:** expected amount (order total − prepaid), courier-reported collected amount, courier fee, return fee, and settlement batch are stored as ledger entries; reconciliation matches settlement lines to orders and flags mismatches rather than silently adjusting.
- Phone numbers stored normalised E.164 plus the original; addresses stored structured (division / district / upazila / area) with a free-text line, since courier APIs need district and zone ids.
- Migrations: Prisma Migrate, forward-only, reviewed SQL (RLS policies are hand-written SQL in migrations). Local dev DB and a separate test DB per run.

## 7. API design

- REST, JSON, prefix `/v1`. Resource-oriented. OpenAPI 3.1 generated by `@nestjs/swagger` and published at `/docs`; `api-client` is generated from it in CI and drift fails the build.
- Validation: Zod schemas from `contracts` through a Nest pipe; the same schemas validate on the client.
- Errors: RFC 9457 `application/problem+json` with stable `code` values from `contracts`.
- Pagination: cursor-based (`?cursor=&limit=`), stable ordering on `(created_at, id)`.
- **Idempotency:** `Idempotency-Key` header on all non-idempotent POSTs (create order, create shipment, record payment); stored per tenant with request hash.
- Webhooks in: public endpoints verifying signatures, writing to an `inbox_event` table and acknowledging immediately, with processing in the worker (dedupe by provider event id).
- Outbox: domain events written in the same transaction as the state change, then published to BullMQ by a relay, so no event is lost on a crash.
- Observability: request id propagation, structured JSON logs (pino) with `tenantId`, `/health/live` and `/health/ready`, OpenTelemetry hooks added in the hardening phase.
- Rate limiting per tenant and per IP; request size limits; Helmet; strict CORS allow-list.

## 8. Background jobs

BullMQ queues: `courier-sync`, `courier-webhooks`, `reconciliation`, `notifications`, `reports`, `imports`. Jobs are idempotent, use exponential backoff with a dead-letter queue, and are visible through a protected admin board. Scheduled work uses BullMQ job schedulers (not in-process cron) so multiple workers do not double-fire.

## 9. Frontend notes

- **Web:** Next.js App Router; data via TanStack Query against `api-client`; auth through the in-memory access token plus cookie refresh. i18n with `bn` and `en` from day one (Bangla is a first-class language, with Bangla numerals as a display option). Dhaka timezone formatting.
- **Mobile:** Expo Router; offline-tolerant order capture (queue writes locally and sync with idempotency keys); push via Expo Notifications (needs credentials in Phase 7).

---

## 10. Technical risks

| #   | Risk                                                                                                                                                                                               | Impact                                     | Mitigation                                                                                                                             |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------- |
| R1  | **Version drift between Expo and web React**                                                                                                                                                       | Broken mobile builds                       | Exact pinning, overrides, CI drift check, `expo install` only, `expo-doctor` in CI.                                                    |
| R2  | **Prisma 8 RC / TS 7 major churn**                                                                                                                                                                 | Unstable tooling                           | Stay on Prisma 7.10 stable and TS 6.0; scheduled upgrade spikes.                                                                       |
| R3  | **Tenant data leakage**                                                                                                                                                                            | Existential                                | Three-layer isolation (§5), mandatory isolation tests, non-bypass DB role.                                                             |
| R4  | **Prisma + RLS** requires per-request transaction with `set_config`; connection-pool misuse can leak the setting                                                                                   | Leakage or latency                         | Always `set_config(..., true)` (transaction-local) inside `$transaction`; benchmark early (Phase 1). Fallback: raw `pg` for hot paths. |
| R5  | **Courier APIs** (Pathao, Steadfast, RedX, Paperfly) are inconsistent, sparsely documented, and change; sandbox availability varies                                                                | Delays, wrong statuses                     | `CourierAdapter` interface, recorded-fixture contract tests, mock adapter, normalised status mapping table, feature flag per courier.  |
| R6  | **COD money correctness** (partial deliveries, courier fees, delayed settlement)                                                                                                                   | Financial disputes                         | Integer paisa, append-only ledger, property-based tests in `domain`, reconciliation reports that surface mismatches.                   |
| R7  | **Meta (Facebook/Instagram) API access** needs app review, business verification, and tight policies; messaging windows limited                                                                    | Social order import may be blocked or slow | Treat as late-phase and optional; ship manual and bulk-import order entry first; build against a mock webhook.                         |
| R8  | **Overselling / race conditions** in inventory                                                                                                                                                     | Wrong stock                                | Row locking, ledger, concurrency tests.                                                                                                |
| R9  | **Bangladesh specifics**: phone and address normalisation, Bangla text and fonts, low-end Android and poor connectivity, SMS sender-ID (BTRC) rules, local payment rails (bKash/Nagad) for billing | Poor UX or blocked launch                  | Normalisation lib in `domain`, offline-tolerant mobile, i18n early, defer billing and SMS provider choice.                             |
| R10 | **Mobile store release** (Apple dev account, Play console, signing)                                                                                                                                | Launch delay                               | Start accounts early (needs the user); use EAS internal distribution first.                                                            |
| R11 | **Webhook replay, duplication, ordering**                                                                                                                                                          | Corrupt order status                       | Inbox table, dedupe, monotonic status rules.                                                                                           |
| R12 | **PII and compliance** (customer names, phones, addresses)                                                                                                                                         | Legal and reputational                     | Encrypt secrets (courier credentials) with envelope encryption, field-level access logging, data-retention policy, backups.            |
| R13 | **Scope size** for a small team                                                                                                                                                                    | Never ships                                | Strict phase gates (see implementation plan); web-first, mobile after the API stabilises.                                              |
| R14 | **Courier credentials stored per tenant**                                                                                                                                                          | Credential theft                           | AES-256-GCM with a KMS-style master key from env, never logged, redacted in responses.                                                 |

---

## 11. Decision log

| ID  | Decision                                                | Status   |
| --- | ------------------------------------------------------- | -------- |
| A1  | pnpm workspaces + Turborepo monorepo                    | Proposed |
| A2  | Shared-schema multitenancy with RLS as defense-in-depth | Proposed |
| A3  | JWT access + rotating opaque refresh, argon2id          | Proposed |
| A4  | Money as integer paisa                                  | Proposed |
| A5  | Separate `worker` process; BullMQ                       | Proposed |
| A6  | React pinned to Expo's version (19.2.3) for all apps    | Proposed |
| A7  | Prisma 7.10.0 stable, TypeScript 6.0.3                  | Proposed |
| A8  | OpenAPI-generated client + shared Zod contracts         | Proposed |
| A9  | Appended ledgers for stock, COD, order events, audit    | Proposed |

---

## 12. Phase 1 implementation notes (identity and tenancy)

What was built, and where it deliberately differs from the sections above. Everything here is covered by `apps/api/test/*.e2e.test.ts`.

### Tenant isolation as built

- **No Prisma query-rewriting extension.** Section 5 proposed injecting `tenantId` into `where` and `data`. Instead, `Database.withContext({ tenantId, userId }, fn)` (`packages/db/src/database.ts`) opens one interactive transaction, runs `set_config('app.tenant_id' / 'app.user_id', ..., true)` first, and hands `fn` the transaction client. Row-level security is then the single enforcement point, so there is no second filter to drift out of sync. Tenant models are reachable only inside `withContext`; `Database.global` is typed to the three global models.
- **Table classification** (`packages/db/src/tables.ts`): tenant tables `tenants`, `memberships`, `invitations`, `audit_logs` (forced RLS); global tables `users`, `sessions`, `refresh_tokens` (reached before a tenant is known, keyed by unique identity or 256-bit secrets, no tenant business data). A test fails if any table is unclassified.
- **Policies** (`prisma/migrations/*_rls`): `tenants` by `id`; `invitations` by `tenant_id`; `memberships` SELECT also allows `user_id = app.user_id` so login can list the tenants a user belongs to (writes stay tenant-only); `audit_logs` is append-only (INSERT and SELECT only; INSERT also accepts `tenant_id IS NULL` for tenant-less security events, which the application can never read back).
- **Roles:** `app_migrator` (owns tables, runs migrations) and `app_user` (runtime; NOSUPERUSER, NOBYPASSRLS, not an owner). `pnpm db:setup` creates them idempotently with a superuser URL used for nothing else. It intentionally never issues a blanket `GRANT ... ON ALL TABLES`: the isolation suite caught that doing so on re-run silently undid the per-table `REVOKE`s, so migration `*_assert_privileges` re-asserts them.
- **Creating a tenant without a bypass:** ids are generated in the application (UUIDv7), and the context is set to the new tenant id before the first insert, so `WITH CHECK (id = current tenant)` passes naturally. Invitations embed the tenant id in the token (`inv_<tenantId>_<secret>`) so accepting one needs no cross-tenant lookup.
- **Measured cost:** the per-request transaction adds about 2 ms at p95 (local Docker PostgreSQL; budget 15 ms). Run `pnpm --filter @orderloop/api bench:tenant`.

### Authentication as built

- Access token: EdDSA JWT, 15 min, claims `sub`, `tid`, `sid` only. **The role is not trusted from the token.** `AccessGuard` re-reads the session and the membership on every request, so logout, demotion and removal take effect immediately. (Section 4 mentioned a short-TTL Redis cache for this; it is deferred until it is needed, because correctness is simpler without it.)
- Refresh tokens: opaque, SHA-256 hashed at rest, single use. Replay of a used token, or two concurrent exchanges of one token, revokes the whole session (compare-and-set on `used_at`). There is no grace period, so a client that double-submits a refresh will be signed out; add a short grace window only if real clients need it.
- Passwords: argon2id (19 MiB, t=2, p=1), 10 to 128 characters, no composition rules. Login does a dummy verification for unknown emails and returns one error for every credential failure.
- Brute force: per-IP request rate limits (strict on credential routes) plus two lockout counters in Redis: 5 failures per (account, IP) pair per 15 minutes, and 50 failures per account across all IPs. The pair counter means someone else's bad guesses cannot lock the real owner out from their own IP; the account-wide counter catches guessing spread across many IPs. Both fail open if Redis is down. The IP limiter is in-memory per instance; use a shared store before running multiple replicas. Set `TRUST_PROXY` to the exact number of proxy hops in production, otherwise every client shares the proxy's IP.
- Invitations carry their inviter's authority. Acceptance re-checks that the inviter is still a member who may grant that role (and permanently revokes the invitation if not); removing or demoting a member revokes their pending invitations; OWNER and ADMIN can list and revoke invitations (an ADMIN only for roles they could grant).
- Web clients (`x-client: web`) get the refresh token as an HttpOnly, SameSite=Lax cookie scoped to `/v1/auth`, never in JSON; the refresh route then requires the header and an allowed `Origin`. Native clients receive it in the body.
- Signing keys come from `JWT_PRIVATE_KEY` / `JWT_PUBLIC_KEY`. Development generates an ephemeral key at start-up; production refuses to start without them.
- Roles and rules live in `packages/domain/src/permissions.ts`: an ADMIN cannot create, change or remove OWNERs or ADMINs; a tenant always keeps at least one OWNER (owner rows are locked and the actor's role is re-read under that lock, so concurrent demotions cannot both succeed).

### API contract as built

- **One route registry** (`packages/contracts/src/routes.ts`) defines every endpoint: method, path, auth, permission, params, query, body, response. The NestJS controllers bind to it (`@Endpoint(routes.x)`), requests are validated against it, the typed client (`packages/api-client`) is generated from it at the type level, and the OpenAPI 3.1 document is built from it. Section 7 proposed `@nestjs/swagger`; this replaces it, since the contract cannot drift from the code by construction. `docs/openapi.json` is committed and a test fails when it is stale (`pnpm --filter @orderloop/api openapi`).
- Errors are RFC 9457 problem details with a stable `code`. Unauthenticated, forbidden and not-found cases are deliberately uniform where distinguishing them would leak information (for example, another tenant's member id returns 404, not 403).
- Invitation delivery goes through an `InviteSender` seam. Development logs the link; production refuses to start sending until an email provider is configured. The token is never returned to the inviter.

### Decision log additions

| ID  | Decision                                                                                       | Status      |
| --- | ---------------------------------------------------------------------------------------------- | ----------- |
| A10 | RLS via `withContext` transactions; no query-rewriting Prisma extension                        | Implemented |
| A11 | Role and membership re-read on every request; no authorisation cache yet                       | Implemented |
| A12 | Route registry in `contracts` is the single source for controllers, client and OpenAPI         | Implemented |
| A13 | Global auth tables (`users`, `sessions`, `refresh_tokens`) are not tenant-scoped, by allowlist | Implemented |

### Independent security review (Phase 1)

A separate reviewer read the auth, session, RLS and member code with no access to this document's conclusions. Result: no critical or high findings; cross-tenant access, role escalation, refresh-token reuse bypass, secret leakage, CSRF/CORS and SQL injection were each examined and none found. Items raised and how they were handled:

| Finding                                                                   | Handling                                                                                                                                                  |
| ------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Medium: pending invitations outlived the inviter and could not be revoked | Fixed: accept-time inviter check, revoke on remove or demote, list and revoke endpoints, tests.                                                           |
| Low: per-account lockout could be used to lock a victim out               | Mitigated: lockout is per (account, IP); a separate high account-wide threshold remains for distributed guessing.                                         |
| Low: no `trust proxy` setting                                             | Fixed: `TRUST_PROXY` hop count.                                                                                                                           |
| Low: registration reveals whether an email is taken (409)                 | Accepted for now (10 requests per minute per IP). Revisit with email verification.                                                                        |
| Note: the console invite sender logs live links outside production        | Accepted. Never run an internet-facing host with `NODE_ENV=development`; production uses a sender that refuses until a real email provider is configured. |

| ID  | Decision                                                           | Status      |
| --- | ------------------------------------------------------------------ | ----------- |
| A14 | Lockout keyed per (account, IP) plus a high account-wide threshold | Implemented |
| A15 | Invitations are bound to their inviter's current authority         | Implemented |
