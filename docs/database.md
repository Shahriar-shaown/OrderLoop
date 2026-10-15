# Database

PostgreSQL 16 through Prisma 7.10 (schema `packages/db/prisma/schema.prisma`, migrations
`packages/db/prisma/migrations`). This page covers the data model, how tenants are isolated, the database roles, how to work
with migrations, and the development seed. For API behaviour see [api.md](api.md); for the reasoning behind the design see
[architecture.md](architecture.md) sections 5 and 12.

## Naming: business, tenant, membership

The product says "business"; the schema says **tenant**. `Tenant` is the business, `Membership` is the link between a
person and a business (what a "BusinessMembership" would be), and `User` is the person. One user can belong to many tenants
with a different role in each. Nothing was renamed, to keep the approved architecture and its tests intact.

## Conventions

- Primary keys are UUIDv7 (time-ordered). Rows created by the API get their id from the application so a tenant's context
  exists before its row does; other defaults use Prisma's `uuid(7)`.
- Timestamps are `timestamptz`, stored in UTC. Table and column names are `snake_case` in the database and `camelCase` in code.
- Tokens and passwords are stored only as hashes: argon2id for passwords, SHA-256 for random 256-bit tokens. No plaintext
  credential or token is ever stored.
- Money (from the orders phase on) is integer paisa. There is none in the schema yet.

## Tables

Seven tables carry authentication and tenancy. Tenant tables hold a tenant's data and are protected by row-level security
(RLS); global tables are reached before a tenant is known (signing in, redeeming an emailed link) and are keyed by unique
identity or unguessable secrets.

| Table            | Scope  | Purpose                                                                                                                                                                                                                |
| ---------------- | ------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `users`          | global | A person. `email` (unique, stored lower-case), `name`, `password_hash`, `email_verified_at` (null until verified), `disabled_at` (an account switch that revokes access at once).                                      |
| `sessions`       | global | One per sign-in. `user_id`, `active_tenant_id` (the tenant the access token is scoped to), `expires_at` (absolute, 90 days), `revoked_at` and `revoked_reason`, `ip`, `user_agent`.                                    |
| `refresh_tokens` | global | `session_id`, `token_hash` (unique), `expires_at`, `used_at` (set when exchanged; presenting a used token is theft), `replaced_by_id` (rotation chain).                                                                |
| `user_tokens`    | global | One-time emailed tokens. `user_id`, `purpose` (`EMAIL_VERIFICATION` or `PASSWORD_RESET`), `token_hash` (unique), `expires_at`, `used_at`.                                                                              |
| `tenants`        | tenant | The business. `name`. RLS: a row is visible only when its `id` is the current tenant.                                                                                                                                  |
| `memberships`    | tenant | `tenant_id`, `user_id`, `role` (`OWNER`, `ADMIN`, `MANAGER`, `STAFF`, `ACCOUNTANT`). Unique on (`tenant_id`, `user_id`).                                                                                               |
| `invitations`    | tenant | `tenant_id`, `email`, `role`, `token_hash` (unique), `invited_by_id`, `expires_at`, `accepted_at`, `revoked_at`.                                                                                                       |
| `audit_logs`     | tenant | Append-only security and administration trail. `tenant_id` (null for events with no tenant, such as a failed sign-in for an unknown address), `actor_user_id`, `action`, `target_type`, `target_id`, `metadata`, `ip`. |

The list of which table is which lives in `packages/db/src/tables.ts`, and a test fails if a table exists that is in neither
list.

```
users 1──* memberships *──1 tenants 1──* invitations
  │
  ├─* sessions 1──* refresh_tokens          audit_logs (tenant_id, no foreign keys: history outlives its rows)
  └─* user_tokens
```

## Tenant isolation

Every request that touches tenant data runs inside **one transaction that first sets two transaction-local settings**,
`app.tenant_id` and `app.user_id`, and every tenant table has **forced row-level security** policies that read them.
With no setting, a tenant table returns no rows and rejects writes, so a query that forgets its context fails closed
instead of leaking.

```ts
// packages/db/src/database.ts: the only door to tenant data
await db.withContext({ tenantId, userId }, async (tx) => {
  /* every query here is constrained by RLS to this tenant */
});
```

Policies, in `prisma/migrations/*_rls`:

| Table         | Policy                                                                                                                                                                    |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `tenants`     | `id = app_current_tenant()`, for reads and writes.                                                                                                                        |
| `invitations` | `tenant_id = app_current_tenant()`, for reads and writes.                                                                                                                 |
| `memberships` | Read: `tenant_id` matches **or** `user_id = app_current_user()` (so sign-in can list the tenants a user belongs to). Insert, update and delete: `tenant_id` matches only. |
| `audit_logs`  | Read: `tenant_id` matches. Insert: `tenant_id` matches or is null. Update, delete and truncate are not granted at all (append-only).                                      |

The API never takes a tenant or user id from the client. They come from the verified access token, and the membership
(hence the role) is re-read from the database on each request. A tenant is created without any bypass: the application
generates the tenant's id, sets the context to it, and inserts, so the insert policy passes naturally.

The user and tenant models are reached by two typed handles: `withContext` (tenant data) and `Database.global` (typed to
only `user`, `session`, `refreshToken`, `userToken`).

### Database roles

`pnpm db:setup` creates these (idempotent, using a superuser URL that nothing else uses):

| Role           | Used for                                     | Privileges                                                                                                                                                                                                                          |
| -------------- | -------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `app_migrator` | `prisma migrate`; owns the schema and tables | Create and alter schema objects. Has `CREATEDB` so Prisma can use a shadow database. Never used at runtime.                                                                                                                         |
| `app_user`     | The API and worker (`DATABASE_URL`)          | `SELECT`, `INSERT`, `UPDATE`, `DELETE` on tables, except: no `UPDATE`/`DELETE`/`TRUNCATE` on `audit_logs`, no access to `_prisma_migrations`. **No superuser, no `BYPASSRLS`, not an owner**, so it cannot disable or sidestep RLS. |

The setup script grants the runtime role access only through `ALTER DEFAULT PRIVILEGES`, never a blanket
`GRANT ... ON ALL TABLES`, because re-running that would undo the per-table revokes. A migration re-asserts them.

## Migrations

| Migration                                          | Contents                                                                                                          |
| -------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `20261015154934_init`                              | Enum `Role`; tables `users`, `tenants`, `memberships`, `sessions`, `refresh_tokens`, `invitations`, `audit_logs`. |
| `20261015160000_rls`                               | The two helper functions, forced RLS and policies on the four tenant tables, audit append-only grants.            |
| `20261015161250_email_verification_password_reset` | Enum `TokenPurpose`, `users.email_verified_at`, table `user_tokens`.                                              |
| `20261015170000_assert_privileges`                 | Re-asserts the least-privilege revokes (idempotent).                                                              |

```bash
pnpm db:init                  # roles, then apply every migration (safe to repeat)
pnpm db:migrate               # after editing schema.prisma: create and apply a development migration
pnpm db:migrate:deploy        # apply existing migrations only (what CI and production use)
pnpm --filter @orderloop/db run migrate:status
```

Rules for changing the schema:

1. **A new tenant-owned table needs RLS in the same migration**: `ENABLE` and `FORCE ROW LEVEL SECURITY`, a policy on
   `tenant_id`, and an entry in `tables.ts`. The isolation tests fail until all three exist.
2. Migrations are forward-only and reviewed as SQL. Never edit one that has been applied elsewhere; add a new one.
3. Statements that reference Prisma's own bookkeeping table must be conditional (see the existing `DO $$ ... to_regclass`
   guard): Prisma's shadow database replays migrations before that table exists.
4. Commit the generated migration folder, not the generated client (`packages/db/src/generated` is git-ignored and rebuilt by
   `pnpm build`).

### Local databases

The compose file runs PostgreSQL on **localhost:5433** (not 5432, so it does not clash with a Homebrew install). The API uses
database `orderloop`; the integration tests use a separate `orderloop_test` (same roles), so they never touch your
development data. To start over:

```bash
pnpm services:down                # stops containers, keeps the data volume
docker volume rm orderloop_pgdata   # wipes ALL local database data (check the name with `docker volume ls`)
pnpm services:up && pnpm db:init && pnpm db:seed
```

## Development seed data

```bash
pnpm db:seed      # idempotent
```

Creates one fictional workspace, "Demo Shop (seed data)", with three fictional people whose emails are on the reserved
`.test` domain (which can never receive mail) and whose addresses are already verified:

| Role  | Email                       |
| ----- | --------------------------- |
| OWNER | `owner@demo.orderloop.test` |
| ADMIN | `admin@demo.orderloop.test` |
| STAFF | `staff@demo.orderloop.test` |

The shared password is the documented throwaway `demo-password-change-me` (override with `SEED_PASSWORD`). No real personal
information is used. The script **refuses to run** when `NODE_ENV=production` or when the database host is not local
(`localhost`, `127.0.0.1`, `::1`), with no override flag.

## Verifying isolation

`apps/api/test/tenant-isolation.e2e.test.ts` attacks the database layer directly as `app_user` and through the HTTP API:
no context returns zero rows; a tenant reads, updates, deletes and inserts only its own rows; a pooled connection never carries a
previous tenant's context (interleaved stress); the audit log cannot be updated or deleted; every table is classified and
every tenant table has forced RLS and a policy; the runtime role cannot bypass RLS, own tables or read migration bookkeeping;
and one tenant cannot reach another's members, audit log or invitations through any route.
