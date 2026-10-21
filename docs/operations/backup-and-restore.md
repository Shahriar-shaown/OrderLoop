# Backup and restore

What to back up, how, and how to prove a backup works. Everything here is written against this repository (PostgreSQL 16, Redis 7,
roles from `pnpm db:setup`). Numbers called "proposed" are suggestions for the pilot, not commitments.

> **Status.** The project has run **one** restore drill, on a developer laptop against the local Docker PostgreSQL, on
> 2026-10-21 (full output in [Local drill](#local-drill-performed-on-2026-10-21)). **No restore from a production or staging
> backup has been performed**, no WAL archiving or point-in-time recovery has been set up or tested, and no backup job exists in
> this repository. Treat the production procedure below as untested until your own drill is recorded in the
> [checklist](#restore-test-checklist).

## 1. What holds state

| Store                                                    | Holds                                                                                                                                                                                       | Back it up?                                   | If lost                                                                                                                                                          |
| -------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **PostgreSQL** (`orderloop` database)                    | Everything that matters: accounts, tenants, orders, stock ledger, shipments, finance, audit log, sealed courier credentials and Meta page tokens, automation state                          | **Yes, mandatory**                            | Business data is gone.                                                                                                                                           |
| **`COURIER_CREDENTIALS_KEY`** (+ `_KEY_ID`, `_OLD_KEYS`) | The AES-256-GCM key that seals courier credentials, courier webhook secrets and Meta page tokens (`access_token_enc`). It is an environment variable, **not** in the database.              | **Yes, separately from the database backups** | Every saved courier credential and Meta token becomes unreadable. Sellers re-enter courier credentials and reconnect Meta. No data is otherwise lost.            |
| **`JWT_PRIVATE_KEY` / `JWT_PUBLIC_KEY`**                 | Ed25519 key that signs 15-minute access tokens                                                                                                                                              | Yes (cheap to keep)                           | Generate a new pair. Outstanding access tokens stop verifying; refresh tokens are opaque and live in the database. See [section 3](#3-keys-and-secrets-custody). |
| Other secrets                                            | `META_APP_SECRET`, `META_WEBHOOK_VERIFY_TOKEN`, `SMTP_PASSWORD`, `EXPO_ACCESS_TOKEN`, database passwords                                                                                    | Yes, in the secret manager                    | Re-issue at the provider and redeploy.                                                                                                                           |
| **Redis**                                                | BullMQ queues (`imports`, `automation`, `automation-delivery`, `automation-tick`, `meta-events`, `meta-health`) and the sign-in lockout counters. **Queue state only, no source of truth.** | **No** (see [section 4](#4-redis))            | In-flight and retry state is lost; sweepers re-queue what the database says is unfinished. Lockout counters reset.                                               |
| Object storage                                           | **None exists.** Product images are plain `https` links to somewhere else; import CSVs live in `import_jobs.csv` only until processing ends; exports are streamed.                          | n/a                                           | n/a                                                                                                                                                              |
| Container images / source                                | Rebuilt from git: `pnpm install --frozen-lockfile && pnpm build`                                                                                                                            | Tag every release in git                      | Rebuild.                                                                                                                                                         |

The mobile app keeps nothing that is not on the server (refresh token in the phone's secure storage, everything else is a cache).

## 2. PostgreSQL

### Proposed targets (pilot)

| Target                            | Proposal                                                                                                                                                                           |
| --------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| RPO (data you can afford to lose) | **15 minutes** with WAL archiving / provider point-in-time recovery. **24 hours** if you only take a nightly `pg_dump` (state this to pilot users).                                |
| RTO (time to be serving again)    | **4 hours** for the pilot, measured by the restore drill, not guessed.                                                                                                             |
| Retention                         | Daily dumps for 14 days, weekly for 8 weeks; WAL/PITR window of at least 7 days. Delete dumps of deleted tenants on the same schedule (see [PII](#backups-contain-personal-data)). |
| Drill frequency                   | Before the pilot starts, then monthly and after any change to roles, migrations tooling or PostgreSQL major version.                                                               |

### Strategy

Use **both**, if the host allows it:

1. **Continuous**: your managed provider's automated backups with point-in-time recovery, or self-managed base backups plus WAL
   archiving (`archive_mode=on`, `archive_command`, e.g. with pgBackRest or WAL-G). Not set up by this repository and **not tested**.
2. **Logical**: a nightly `pg_dump`, copied off the database host, encrypted, with a recorded restore test. This is the only
   method the project has exercised (locally).

A logical dump alone gives an RPO of up to a day and cannot restore to a point in time.

### The row-level-security trap (read before writing the backup job)

Every tenant table has `FORCE ROW LEVEL SECURITY`, so **even the table owner is filtered by the policies**, and with no
`app.tenant_id` set a normal role sees no rows. Verified locally on 2026-10-21 against the dev database:

| Dump run as                                 | Result                                                                                                                                                                                                                                                                                                  |
| ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `app_migrator` (owner), default             | **Fails**: `ERROR: query would be affected by row-level security policy for table "audit_logs"` ... `HINT: To disable the policy for the table's owner, use ALTER TABLE NO FORCE ROW LEVEL SECURITY.` Do not follow the hint.                                                                           |
| `app_migrator` with `--enable-row-security` | **Succeeds and is silently incomplete.** The dump held rows only for tables with an owner-only policy or no RLS (`tenants` 11, `automation_rules`, `social_*`, auth tables) and **no orders, customers, stock, shipments, finance rows**. A backup like this looks fine and restores an empty business. |
| `app_user`                                  | Cannot dump (no `BYPASSRLS`, not owner); would see nothing.                                                                                                                                                                                                                                             |
| A superuser (or a role with `BYPASSRLS`)    | **Complete.** This is the role to back up with.                                                                                                                                                                                                                                                         |

So: **back up as a superuser or a dedicated backup role with `BYPASSRLS`** (a read-only role such as one with `pg_read_all_data`
**and** `BYPASSRLS`; creating it is not done by `pnpm db:setup`, and it is **not tested**). Never use `--enable-row-security`
for backups. On managed PostgreSQL where no superuser exists, use the provider's snapshot/PITR, or confirm with the provider
which role can dump past forced RLS, and verify with the row-count check in [section 6](#6-restore-drill-procedure) before
trusting it.

### Take a logical backup

Run from a machine that can reach the database; `--format=custom` is compressed and lets `pg_restore` select and parallelise.
Use a `~/.pgpass` file or a secret-injected `PGPASSWORD`, never a password on the command line.

```bash
STAMP=$(date -u +%Y%m%dT%H%M%SZ)
pg_dump --host "$DB_HOST" --port "$DB_PORT" --username "$DB_BACKUP_USER" --dbname orderloop \
        --format=custom --compress=6 --file "orderloop-$STAMP.dump"

# Prove the file is readable and not truncated (does not prove the data is complete):
pg_restore --list "orderloop-$STAMP.dump" | tail -3

# Encrypt before it leaves the host (example with age; use your own tooling), then copy off-host:
age -r "$AGE_RECIPIENT" -o "orderloop-$STAMP.dump.age" "orderloop-$STAMP.dump" && shred -u "orderloop-$STAMP.dump"
```

The local Docker database is `localhost:5433`; the superuser in `.env.example` is `orderloop`. In the compose container, `pg_dump`
version is 16.15; use a client of the same or a newer major version than the server.

What a dump includes and does not:

- Includes: schema, data, indexes, **row-level-security flags and policies, `SECURITY DEFINER` functions, table ownership and
  grants (ACLs)**, and `_prisma_migrations` (so `prisma migrate status` still works after a restore).
- Does **not** include: **roles** (they are cluster-level; `app_migrator` and `app_user` must exist before the restore, see
  below), passwords, extensions' binaries, Redis, environment variables or keys.
- Dump **one database**. Do not use `pg_dumpall` for routine backups.

### Backups contain personal data

A dump holds customer names, phones and addresses, session hashes and sealed secrets. Treat it like production: encrypted at
rest, access-controlled and logged, never copied to a laptop, and deleted on schedule. A tenant that has asked for deletion
remains in older backups until they expire: say so in the retention statement (see
[incident-response.md](incident-response.md#data-deletion-request)). The sealed credentials in a dump are useless without
`COURIER_CREDENTIALS_KEY`, which is another reason to keep the key elsewhere.

## 3. Keys and secrets custody

| Secret                                                 | Where it lives                     | Custody proposal                                                                                                                                                                                                    |
| ------------------------------------------------------ | ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `COURIER_CREDENTIALS_KEY`, `_KEY_ID`, `_OLD_KEYS`      | Secret manager / deployment env    | Two named custodians. A copy in an offline sealed store (password manager vault or printed and locked). **Never in the same bucket as the database dumps.** `_OLD_KEYS` must keep every key that still seals a row. |
| `JWT_PRIVATE_KEY`, `JWT_PUBLIC_KEY`                    | Secret manager / deployment env    | Same custodians. Generated by `pnpm --filter @orderloop/api auth:generate-keys` (prints to the terminal, writes nothing).                                                                                           |
| `META_APP_SECRET`, `META_WEBHOOK_VERIFY_TOKEN`         | Secret manager; Meta app dashboard | The dashboard is the second copy of `META_APP_SECRET`.                                                                                                                                                              |
| Database passwords (`app_user`, `app_migrator`, admin) | Secret manager                     | Restoring the database does not restore role passwords.                                                                                                                                                             |

How each loss behaves (from reading the code; **not tested** by swapping keys on a running system):

- **Lose `COURIER_CREDENTIALS_KEY` entirely**: the API cannot decrypt courier credentials or Meta tokens. There is no recovery;
  couriers must be reconfigured and Meta connections made again. The simulated courier and everything else keep working. A key
  that is merely wrong (typo, truncated) fails the same way, and `COURIER_CREDENTIALS_KEY` must decode to exactly 32 bytes or the
  process refuses to start.
- **Lose the JWT keys**: set a new pair and restart. Access tokens signed by the old key fail verification (clients get 401 and
  refresh); refresh tokens and sessions are in the database and are unaffected. There is one active key (no multi-key
  verification), so a rotation invalidates every outstanding access token at once, for at most 15 minutes of nuisance.
- **Rotating `COURIER_CREDENTIALS_KEY`**: see [incident-response.md](incident-response.md#suspected-credential-or-token-leak).
  There is **no re-encryption tool**: old values keep working through `COURIER_CREDENTIALS_OLD_KEYS` and are re-sealed with the
  new key only when a business saves them again.

## 4. Redis

Redis holds **queue state and lockout counters only**. Do not back it up and do not treat it as durable. Recommended settings
(BullMQ guidance, not enforced by the repo): `maxmemory-policy noeviction`, a password, and `rediss://` if it crosses a network.

If Redis is wiped (or the instance is replaced) the system recovers on its own once the API and worker reconnect. What happens,
from the code and `docs/automation.md`, `docs/meta.md` (the exact scenarios are covered by the integration tests listed there;
a full-wipe-in-production exercise has **not** been done):

| Work item                                                             | State in PostgreSQL                        | Recovery after Redis returns empty                                                                                                                                                                                                                    |
| --------------------------------------------------------------------- | ------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| CSV imports                                                           | `import_jobs.status = PENDING`             | The sweeper (every 30 s) re-queues PENDING imports older than 60 s and RUNNING ones not restarted for 15 min (`stalled_running_imports()`); a stalled job Redis still holds is redelivered by BullMQ itself. Wiped Redis: it resumes in about 16 min. |
| Meta webhook events                                                   | `social_events.status = received`          | The Meta sweeper re-queues them (about a minute).                                                                                                                                                                                                     |
| Automation evaluations                                                | `automation_runs` with deterministic slots | The minute tick re-registers (`registerTick` runs at worker start) and queues what is due; a missed slot is re-queued by the scan, except daily/weekly reports whose local day has ended.                                                             |
| Notification deliveries                                               | `notification_deliveries.status = pending` | The tick re-queues `pending` deliveries older than a minute.                                                                                                                                                                                          |
| Daily Meta health check                                               | scheduler                                  | Re-registered at worker start (`registerHealthSchedule`).                                                                                                                                                                                             |
| Failed-job history (kept 1 to 7 days)                                 | none                                       | Lost. Failed runs and deliveries are still visible in PostgreSQL through the automation endpoints.                                                                                                                                                    |
| Expo push receipt checks (15 min delayed)                             | none                                       | Lost; dead tokens are removed by the next push's ticket instead.                                                                                                                                                                                      |
| Sign-in lockout counters                                              | none                                       | Reset: an attacker gets a fresh set of guesses (still limited by the per-IP request limit).                                                                                                                                                           |
| Events raised by the API while Redis is down (new-order notification) | none                                       | Not queued; the 5-minute catch-up scan announces new orders, and the API's health check reports `degraded`.                                                                                                                                           |

After a Redis replacement: restart the worker (it re-registers its schedulers), check `/health/ready` is `ok`, and watch the worker
log for `automation.tick` lines every minute.

## 5. Restore: roles and commands

### Roles (what must exist before `pg_restore`)

`pnpm db:setup` creates the cluster-level roles (script: `packages/db/scripts/setup-roles.mjs`, run with
`DATABASE_ADMIN_URL`). The dump references them in its ACLs, so on a **new cluster** run `pnpm db:setup` (or create the two roles
equivalently) first. Without them the grants fail to restore (**not tested**).

| Role           | Properties                                                               | Role in restore                                                         |
| -------------- | ------------------------------------------------------------------------ | ----------------------------------------------------------------------- |
| `app_migrator` | `NOSUPERUSER NOBYPASSRLS CREATEDB`, owns the database, schema and tables | Owner of the restored objects; may restore itself (see below).          |
| `app_user`     | `NOSUPERUSER NOBYPASSRLS NOCREATEDB`                                     | Runtime only. **Never restore as `app_user`**; it cannot create tables. |
| superuser      | `DATABASE_ADMIN_URL` user                                                | Takes the dump; also a valid restorer.                                  |

### Why ownership matters

- Tables, functions and the `SECURITY DEFINER` functions (11 in `public`, all owned by `app_migrator`, for example
  `stale_pending_imports`, `meta_connection_for`, `purge_social_data`) **must be owned by `app_migrator`**. The functions rely on the owner
  being exempt from, or covered by an owner-only policy on, the forced-RLS tables. If a restore leaves them owned by a
  superuser or another role, the worker's cross-tenant sweepers and the Meta webhook behave differently (they run with the
  owner's rights), and the migration tooling cannot alter them. **Restore so that everything is owned by `app_migrator`.**
- The order inside a custom-format dump puts data **before** the `ENABLE`/`FORCE ROW LEVEL SECURITY` statements and policies, which is why the owner can
  restore without bypassing RLS. This was verified (below); do not restore with `--section=data` alone.
- Never "fix" a restore by `ALTER ROLE app_user BYPASSRLS`, `NO FORCE ROW LEVEL SECURITY`, or by granting `app_user` ownership.

### Restore into a new, empty database

```bash
# 1. As the admin/superuser: an empty database owned by the migrator, closed to PUBLIC (what db:setup does)
psql "$DATABASE_ADMIN_URL_POSTGRES_DB" -v ON_ERROR_STOP=1 \
  -c "CREATE DATABASE orderloop OWNER app_migrator" \
  -c "REVOKE ALL ON DATABASE orderloop FROM PUBLIC" \
  -c "GRANT CONNECT ON DATABASE orderloop TO app_user, app_migrator"

# 2a. Restore as the superuser (ownership is restored from the dump):
pg_restore --host "$DB_HOST" --username "$DB_ADMIN_USER" --dbname orderloop --exit-on-error orderloop-<stamp>.dump

# 2b. or restore as the owner role, no superuser needed (verified locally):
PGPASSWORD=... pg_restore --host "$DB_HOST" --username app_migrator --dbname orderloop --no-owner --exit-on-error orderloop-<stamp>.dump
```

`--exit-on-error` makes a partial restore impossible to miss. Do not use `--clean` against a database you care about, and do not
restore into a database that already has tables (you will get hundreds of "already exists" errors and a mixed state).

After restoring: point `DATABASE_URL` (api, worker) and `DATABASE_MIGRATION_URL` at it, run the verification in the next section,
then `pnpm --filter @orderloop/db run migrate:status` (must say "Database schema is up to date!"), then start the apps.
Set role passwords with the secrets from your secret manager if the roles are new (`pnpm db:setup` does it from the URLs).

### Point-in-time recovery

With provider PITR or WAL archiving, restore to a **new instance** at the chosen timestamp, verify there, then repoint the apps.
Do not overwrite the damaged instance until the new one is verified. The exact procedure depends on the provider or tool and is
**not documented or tested here**.

## 6. Restore drill procedure

Do this on a scratch server or scratch database, never on the live one. Name scratch databases `orderloop_restore_drill*` so
they are obvious. Record the date, dump name, timings and results in the [checklist](#restore-test-checklist).

1. Time the whole drill (this is your measured RTO).
2. Restore as in [section 5](#restore-into-a-new-empty-database) into `orderloop_restore_drill`.
3. **Row counts** against the source (take the source counts with the backup role at dump time; rows keep arriving, so compare
   against a quiet source or a snapshot):

   ```sql
   -- run in each database as a superuser; compare the two outputs with diff
   SELECT format('SELECT %L AS t, count(*) AS n FROM public.%I', c.relname, c.relname)
   FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = 'public' AND c.relkind = 'r' ORDER BY c.relname
   \gexec
   ```

4. **Structure, ownership, RLS, grants** (identical numbers expected in source and restore):

   ```sql
   SELECT count(*) FROM pg_tables WHERE schemaname = 'public' AND tableowner <> 'app_migrator';          -- 0
   SELECT count(*) FILTER (WHERE relrowsecurity AND relforcerowsecurity),                                 -- 39
          count(*) FILTER (WHERE relrowsecurity AND NOT relforcerowsecurity),                              -- 1 (push_devices)
          count(*) FILTER (WHERE NOT relrowsecurity)                                                       -- 5 (4 auth tables + _prisma_migrations)
   FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND relkind = 'r';
   SELECT count(*) FROM pg_policies WHERE schemaname = 'public';                                          -- 62
   SELECT count(*), string_agg(DISTINCT pg_get_userbyid(proowner), ',')
   FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'public' AND prosecdef;  -- 11, app_migrator
   SELECT has_table_privilege('app_user', 'public.audit_logs', 'UPDATE');                                 -- f
   SELECT has_table_privilege('app_user', 'public._prisma_migrations', 'SELECT');                         -- f
   ```

   The expected numbers are the ones on the 2026-10-21 schema (20 migrations). **They change when migrations add tables or
   policies**; recompute them from the source database when you run the drill. `TENANT_TABLES` in `packages/db/src/tables.ts`
   (39 entries) is the list the forced-RLS count must match.

5. **Tenant isolation, as the runtime role** (this is the check that matters most):

   ```sql
   -- psql as app_user against the restored database
   SELECT count(*) FROM orders;                      -- 0: no tenant context sees nothing
   SELECT count(*) FROM tenants;                     -- 0
   BEGIN;
   SELECT set_config('app.tenant_id', '<tenant A uuid>', true);
   SELECT count(*) FROM orders;                      -- exactly tenant A's order count
   SELECT count(*) FROM orders WHERE tenant_id <> '<tenant A uuid>';   -- 0
   ROLLBACK;
   BEGIN; UPDATE audit_logs SET action = 'x'; ROLLBACK;   -- ERROR: permission denied for table audit_logs
   SELECT count(*) FROM _prisma_migrations;               -- ERROR: permission denied
   ```

   `pnpm test:integration` is not a check of the restored copy: it always uses a database named `orderloop_test` on the server
   in `DATABASE_URL`, so run it only against a throwaway server, never production. The queries above are the restore check.

6. **Migration state**:
   `DATABASE_MIGRATION_URL=postgresql://app_migrator:...@host:port/orderloop_restore_drill pnpm --filter @orderloop/db run migrate:status`
   must print `Database schema is up to date!` and the right number of migrations.
7. **Application smoke test** against the restored database on a scratch API (different `API_PORT`, scratch Redis index or
   instance, `MAIL_PROVIDER` that cannot send to real people, **no live courier or Meta credentials**): `GET /health/ready` is
   200, a known user can sign in, the order list of a known business matches, a courier connection test either works (right
   `COURIER_CREDENTIALS_KEY`) or fails with a clear "cannot decrypt" (wrong key). A restored database must not be started with
   production `COURIER_CREDENTIALS_KEY` and live Meta/courier webhooks pointed at it, or two systems act on the same accounts.
8. Drop the scratch database (`DROP DATABASE orderloop_restore_drill`), delete the dump copies you made for the drill, record results.

### What NOT to do

- Do not dump or restore with `--enable-row-security`, and do not trust a dump that has not been row-count checked.
- Do not run a restore against the production database "to see". Do not use `--clean`/`--create` against live data.
- Do not weaken RLS to make a backup or restore pass (`NO FORCE ROW LEVEL SECURITY`, `BYPASSRLS` on `app_user`, `app_user` as owner).
- Do not store the dump and `COURIER_CREDENTIALS_KEY` together. Do not email or chat dumps.
- Do not restore over production while the API and worker are running; stop both first (the worker holds queue jobs and sweepers
  that would write into a half-restored database).
- Do not start a restored copy with live outbound integrations enabled (`META_MODE=live`, `PUSH_PROVIDER=expo`, real SMTP, real courier credentials): it will send real email, pushes and may touch real courier accounts.
- Do not rely on `pnpm db:seed`, which refuses to run in production, as part of recovery.
- Do not delete `_prisma_migrations` rows to "fix" a restore; see [migrations.md](migrations.md).

## Restore-test checklist

Copy this block into the release record each time. Unchecked means not done.

- [ ] Backup job exists and runs on schedule; last successful run and its age are visible to someone on call.
- [ ] Backup role verified to produce a **complete** dump (row counts match source), not an RLS-filtered one.
- [ ] Dump encrypted, stored off the database host, access limited and logged.
- [ ] `COURIER_CREDENTIALS_KEY` (and any `_OLD_KEYS`) stored separately, two custodians named, recovery tested by decrypting a courier credential in the drill environment.
- [ ] JWT keys, `META_APP_SECRET`, SMTP and database secrets recoverable from the secret manager.
- [ ] Drill restore completed into a scratch database; **measured duration recorded** (RTO).
- [ ] Row counts identical; ownership, forced RLS, policies, `SECURITY DEFINER` functions, grants as expected.
- [ ] Tenant isolation checks as `app_user` pass on the restored copy.
- [ ] `migrate:status` reports up to date on the restored copy.
- [ ] App smoke test on a scratch API passes; restored copy was started with no live outbound integrations.
- [ ] Scratch database and dump copies deleted.
- [ ] PITR/WAL restore to a chosen timestamp rehearsed (if used): not done by the project.
- [ ] Redis replacement rehearsed: worker restart re-registers schedulers; a `RUNNING` import re-queued by the sweeper after 15 min.
- [ ] Retention and deletion statement written (backups outlive deletion requests by the retention period).

## Local drill (performed on 2026-10-21)

Performed on a developer laptop with the dev Docker PostgreSQL (`orderloop-postgres-1`, image `postgres:16`, `pg_dump` 16.15),
using throwaway databases `orderloop_restore_drill` and `orderloop_restore_drill2`. The development database `orderloop` was only
**read** (dump and counts); no write, no schema change. Both scratch databases and the dump file were removed afterwards
(`SELECT datname FROM pg_database` afterwards: `orderloop`, `orderloop_test`, `postgres`, `template0`, `template1`). The data is fictional development data
(11 tenants, 3 orders), so the drill proves the **procedure and the database-level properties**, not production volume or timing.
It was not timed as a recovery exercise.

| Step                                                                                                                 | Result                                                                                                                                                                                                                                                   |
| -------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pg_dump --format=custom` as owner `app_migrator`                                                                    | Failed: `query would be affected by row-level security policy for table "audit_logs"`                                                                                                                                                                    |
| Same with `--enable-row-security`                                                                                    | Succeeded, but incomplete (tenants 11, auth tables, `social_*`, `automation_rules`; no orders, stock, customers, shipments, finance rows)                                                                                                                |
| `pg_dump --format=custom` as superuser `orderloop`                                                                   | 263,893 bytes, 550 TOC entries                                                                                                                                                                                                                           |
| `CREATE DATABASE orderloop_restore_drill OWNER app_migrator`, revoke PUBLIC, grant CONNECT                           | ok                                                                                                                                                                                                                                                       |
| `pg_restore --exit-on-error` as superuser                                                                            | exit 0, no messages                                                                                                                                                                                                                                      |
| `pg_restore --no-owner --exit-on-error` as `app_migrator` into a second scratch database                             | exit 0, no messages                                                                                                                                                                                                                                      |
| Row counts of all 45 `public` tables, source vs each restore                                                         | **Identical** (`diff` empty). Non-empty tables: `_prisma_migrations` 20, `audit_logs` 77, `refresh_tokens` 257, `sessions` 25, `notification_deliveries` 30, `automation_runs` 32, `stock_movements` 21, `tenants` 11, `users` 12, `orders` 3 and others |
| Tables not owned by `app_migrator`                                                                                   | 0 (source and both restores)                                                                                                                                                                                                                             |
| Forced RLS / enabled-not-forced / not enabled                                                                        | 39 / 1 (`push_devices`) / 5, same as source                                                                                                                                                                                                              |
| Policies; `SECURITY DEFINER` functions and owner                                                                     | 62; 11, all `app_migrator`, same as source                                                                                                                                                                                                               |
| `app_user`: UPDATE on `audit_logs`; SELECT on `_prisma_migrations`; INSERT on `orders`                               | false; false; true, same as source                                                                                                                                                                                                                       |
| As `app_user`, no tenant context                                                                                     | `orders` 0, `tenants` 0                                                                                                                                                                                                                                  |
| As `app_user`, `app.tenant_id` = tenant A / tenant B                                                                 | A: 2 orders, 0 foreign rows; B: 1 order                                                                                                                                                                                                                  |
| As `app_user`: `UPDATE audit_logs`; `SELECT FROM _prisma_migrations`                                                 | `permission denied` for both                                                                                                                                                                                                                             |
| `pnpm --filter @orderloop/db run migrate:status` against the restored database                                       | `20 migrations found in prisma/migrations` / `Database schema is up to date!`                                                                                                                                                                            |
| `prisma migrate diff --from-config-datasource --to-schema prisma/schema.prisma --exit-code` against the dev database | `No difference detected.`                                                                                                                                                                                                                                |

Not done in the drill: application start against the restored database, restoring on a
cluster without the roles, an encrypted/off-host copy, WAL/PITR, timing, and Redis loss.
