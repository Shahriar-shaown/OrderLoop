# Migrations

How the schema changes safely. The mechanics are Prisma 7.10 migrations in `packages/db/prisma/migrations` (SQL files, 20 at the
time of writing), with hand-written row-level-security (RLS) SQL on top. The data model and RLS design are in
[../database.md](../database.md); backups in [backup-and-restore.md](backup-and-restore.md).

## Authoring (development)

```bash
pnpm services:up && pnpm db:init           # roles + apply all migrations to the dev database
# edit packages/db/prisma/schema.prisma
pnpm db:migrate                            # = prisma migrate dev, as app_migrator (DATABASE_MIGRATION_URL)
```

`migrate dev` creates the SQL file, applies it to the dev database and uses a **shadow database** (hence `CREATEDB` on
`app_migrator`). Then:

1. **Read the generated SQL.** Prisma knows nothing about RLS, `SECURITY DEFINER` functions, partial indexes it cannot express, or
   `CHECK` constraints. Add them by hand in the same migration.
2. For a **new tenant-owned table**, the same migration must contain `ENABLE` and `FORCE ROW LEVEL SECURITY`, a policy on
   `tenant_id`, composite `(tenant_id, id)` foreign keys, the right `REVOKE`s for append-only tables, **and** an entry in
   `packages/db/src/tables.ts` (`TENANT_TABLES`, and `APPEND_ONLY_TABLES` if applicable). `apps/api/test/tenant-isolation.e2e.test.ts`
   classifies every table in the database and fails when a table is in neither list or a tenant table lacks forced RLS and a policy.
3. Statements that touch `_prisma_migrations` must be conditional (`DO $$ ... to_regclass ...`): the shadow database replays
   migrations before that table exists.
4. Commit the migration folder together with `schema.prisma`. Do not commit `packages/db/src/generated` (git-ignored, rebuilt by `pnpm build`).
5. Run `pnpm --filter @orderloop/api openapi` if the change alters routes (a test fails on a stale `docs/openapi.json`).
6. Run `pnpm test:integration` (needs `pnpm services:up` and `pnpm db:init`; it uses the isolated `orderloop_test` database).

### Migration names must sort after the latest one

Prisma applies migrations in folder-name order, and the names are timestamps (`YYYYMMDDHHMMSS_name`). At the time of writing the latest
is `20261027100000_meta_social_inbox`, which is **later than the machine's calendar date (2026-10-21)**. A new migration created by
`pnpm db:migrate` would be named with today's real time and sort **before** migrations that are already applied elsewhere, so
environments would apply it in a different order and `migrate dev` may report a diverged history. Until the calendar passes
that date, create the migration without applying, then rename the folder so it sorts last:

```bash
pnpm --filter @orderloop/db exec node scripts/with-root-env.mjs prisma migrate dev --create-only --name my_change
# rename packages/db/prisma/migrations/<new stamp>_my_change to a stamp later than the newest existing folder, then:
pnpm db:migrate
```

This caveat is derived from how Prisma orders migrations and the folder names in the repository; the rename procedure itself has not been rehearsed.

## Applying (CI, staging, production)

```bash
pnpm db:migrate:deploy                                # prisma migrate deploy, as app_migrator
pnpm --filter @orderloop/db run migrate:status        # read-only: pending, failed or drifted migrations
```

- `migrate deploy` applies only the migrations not yet recorded in `_prisma_migrations`, never creates one, never resets, and uses no shadow database.
  It reads `DATABASE_MIGRATION_URL` (the owner role). The runtime role `app_user` cannot run it and has no access to `_prisma_migrations`.
- There is no root `pnpm db:migrate:status` script; use the `--filter` form above.
- CI runs `pnpm db:init` (roles, then `migrate deploy`) on an empty PostgreSQL 16 before the integration tests, so every migration is proven to apply from zero. It does not prove an upgrade of a database with data.
- **Run it from exactly one place, once per release, before starting the new application version.** Two concurrent `migrate deploy` runs are serialised by Prisma's advisory lock, but do not rely on it.
- `pnpm db:setup` (roles) needs `DATABASE_ADMIN_URL` (superuser) and is run once per cluster, not per release.
- Production database names, roles and passwords come from your secrets; `.env.example` values are development defaults.
- **In the Compose deployment (`deploy/docker-compose.yml`) this is the `migrate` service**: a one-shot container that runs on every `docker compose up`, does the role setup (idempotent, no `<db>_test` database), `prisma migrate deploy` as `app_migrator` and `migrate status`, and exits 0 only if all passed; api, worker and the backup loop do not start until it has. It was run on an empty database locally (23 migrations applied). **It was not run as an upgrade of a database that holds data**, and nothing in it takes a backup first: take one (`docker compose exec backup backup.sh`) before a release that has a migration.

## Rules

1. **Never edit a migration that has been applied anywhere** (another developer's database, CI is not "anywhere", staging, production). Prisma stores a checksum
   of each file; a changed file shows up as drift and `migrate dev` will offer to reset the database. Fix forward with a new migration.
2. **Additive first (expand and contract).** Release N adds the column/table/index nullable or with a default and the code that
   tolerates both; release N+1 starts requiring it; release N+2 removes the old shape. Never rename or drop a column or table in the same release as the code change that stops using it.
3. **Migrations are forward-only SQL, reviewed as SQL.** There are no "down" migrations. Rollback is a new forward migration or a restore
   (see below).
4. **SECURITY DEFINER conventions** (see `20261024100000_import_sweep_function`, `20261026100000_automation_notifications`, `20261027100000_meta_social_inbox`):
   - owned by `app_migrator` (created by the migration run), `LANGUAGE sql` or `plpgsql`, `SECURITY DEFINER`;
   - `SET search_path = pg_catalog, public, pg_temp` on every one;
   - `REVOKE ALL ON FUNCTION ... FROM PUBLIC; GRANT EXECUTE ... TO app_user;`
   - return only what the caller needs (ids, not rows), no dynamic SQL from arguments, bounded (`max_rows`);
   - if the owner needs to read a `FORCE`d table inside the function, add an **owner-only** policy (`CREATE POLICY ... FOR SELECT TO CURRENT_USER USING (...)`,
     as `sweep_owner_select` does), never a policy that depends on a setting `app_user` can set itself (an earlier `app.sweep` design was replaced for exactly that reason).
5. **Least privilege is re-asserted, not assumed.** `pnpm db:setup` uses `ALTER DEFAULT PRIVILEGES` only; no migration may rely on a blanket
   `GRANT ... ON ALL TABLES`. Append-only tables (`audit_logs`, `stock_movements`, `order_status_history`, `shipment_events`, `settlement_item_events`)
   keep `UPDATE`/`DELETE`/`TRUNCATE` revoked from `app_user`.
6. **Data fixes are migrations too** (idempotent, tenant-aware, run as owner), or a reviewed one-off script with a recorded run; never ad-hoc `UPDATE`s in a console on production without a second person and a backup taken just before.
7. **Locks and size.** `CREATE INDEX` without `CONCURRENTLY` blocks writes on that table; on a table with real volume use a hand-written
   `CREATE INDEX CONCURRENTLY` (it cannot run inside a transaction block; Prisma runs each migration file in one transaction unless the file is split, **not tested here**). At pilot volume this does not matter; it will later.
8. **Do not use `prisma db push`, `prisma migrate reset` or `prisma migrate resolve` against anything but a disposable development database.**

## Pre-deploy checklist (schema changes)

- [ ] `pnpm check` green (format, versions, boundaries, lint, typecheck, test, build) and `pnpm test:integration` green on a PostgreSQL 16 database built from scratch.
- [ ] Migration SQL read by a second person; RLS, `FORCE`, policies, grants, `search_path` checked by the list above.
- [ ] `TENANT_TABLES` / `APPEND_ONLY_TABLES` updated; isolation test passes.
- [ ] Migration folder name sorts after every existing one.
- [ ] The migration is backwards compatible with the **currently running** application version (expand step), because the old version runs while it is applied.
- [ ] Applied once to a copy of production data (a restored backup, see [backup-and-restore.md](backup-and-restore.md)) and timed; locks considered.
- [ ] A fresh backup taken and verified **immediately before** the production run; its time recorded.
- [ ] `pnpm --filter @orderloop/db run migrate:status` shows exactly the expected pending migrations and nothing failed or drifted.
- [ ] Rollback plan written for this change (below).
- [ ] After applying: `migrate:status` up to date; `prisma migrate diff --from-config-datasource --to-schema prisma/schema.prisma --exit-code` prints `No difference detected.` (run from `packages/db` through `node scripts/with-root-env.mjs`; it was run against the dev database on 2026-10-21 and printed that); `/health/ready` is 200; smoke test ([deployment.md](deployment.md#12-smoke-test-after-deploy)).

## Rollback strategy

There is no automatic rollback. In order of preference:

1. **Roll the application back, leave the schema.** Works when the migration was additive (the expand rule exists to make this possible).
2. **Fix forward**: a new migration that repairs the problem, deployed as a normal release. Default for anything that already wrote data in the new shape.
3. **Restore**: only if data was corrupted or an irreversible migration (drop, type narrowing, destructive data fix) went wrong.
   Restore the backup taken before the run into a **new** database, verify it
   ([backup-and-restore.md](backup-and-restore.md#6-restore-drill-procedure)), switch the apps over, and accept losing the writes made since. Not rehearsed for production.
4. **A migration that fails half-way**: `migrate deploy` stops, records the migration as failed, and refuses to continue. PostgreSQL DDL is transactional, so a
   failed single-file migration normally leaves nothing applied; check with `migrate:status` and inspect before doing anything.
   Do not run `migrate resolve` on production without understanding what state the database is in and taking a backup first.

## Zero-downtime notes

- The API and worker are stateless processes; the schema must work for **both the old and new version** while a rolling restart is in progress. Expand/contract does this.
- Start order: migrate, then worker and API (either order), then web. Stop order for a restore or contract step: web, API, worker.
- The worker holds BullMQ jobs; stopping it (SIGTERM) finishes the current job (`imports.close()`), and a killed worker's jobs are redelivered
  (see `docs/automation.md`, "Idempotency, retries"). A migration that changes a table the worker's jobs use (`import_jobs`, `automation_*`, `social_*`) needs the expand step even more.
- Prisma's client is generated at build time (`prisma generate` inside `pnpm build`); the running version must be built from the same `schema.prisma` it will run against.
- Long migrations: the API's transactions have a 60 s limit; a migration that holds an `ACCESS EXCLUSIVE` lock longer than that produces 5xx. Prefer short statements.
- No blue/green or canary tooling exists in the repository.

## The development-database hand-fix caveat

In this project a development database was once repaired by hand (an index was renamed/changed in the database, and the migration file's
checksum or the index name no longer matched what Prisma expected). The repository itself holds no record of the details; this
section states the general failure and how to avoid it, rather than the specifics.

What goes wrong: an applied migration's file is edited (for example to rename an index so it matches Prisma's default name), or the object is renamed with `psql`, and the database
and the migration history disagree. `migrate dev` then reports drift or a modified migration and wants to reset the database; `migrate deploy`/`migrate status` report a
checksum mismatch; the shadow database (which replays the files) differs from the real one. The fix that "works" (editing `_prisma_migrations.checksum`) hides the problem
and makes other databases diverge.

How to avoid it:

- Treat rule 1 as absolute, including for "tiny" corrections such as a name.
- If an applied migration is wrong, add a new migration (`ALTER INDEX ... RENAME TO ...`), and keep `schema.prisma`'s `map:` names in step.
- If a **development** database drifted, **rebuild it** rather than patching it: `pnpm services:down`, `docker volume rm orderloop_pgdata` (check the name with `docker volume ls`),
  `pnpm services:up && pnpm db:init && pnpm db:seed`.
- Detect drift early: `pnpm --filter @orderloop/db run migrate:status`, and the `migrate diff` command in the checklist (a "no difference" result means the database matches `schema.prisma`; it does not check the checksums of applied files, `migrate status` does).
- CI builds the database from zero with `pnpm db:init`, so a migration file that only works on a hand-patched database fails there.
- Never run `prisma migrate resolve`, edit `_prisma_migrations`, or `ALTER` production objects by hand to make a deploy pass.
