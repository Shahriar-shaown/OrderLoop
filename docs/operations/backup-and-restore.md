# Backup and restore

What to back up, how, and how to prove a backup works. Everything here is written against this repository (PostgreSQL 16, Redis 7,
roles from `pnpm db:setup`). Numbers called "proposed" are suggestions for the pilot, not commitments.

> **Status.** The repository now has a backup job and a restore drill ([`ops/backup.sh`](../../ops/backup.sh),
> [`ops/restore-drill.sh`](../../ops/restore-drill.sh), a `backup` service in [`deploy/docker-compose.yml`](../../deploy/docker-compose.yml)). Both ran
> on a developer laptop on **2026-10-21** against a throwaway PostgreSQL seeded through the API, including four failure cases that must fail
> loudly and did ([drill output](#drill-performed-on-2026-10-21-local)). **Not done:** a restore from a production or staging backup, an
> off-site copy to a real bucket (the code path exists, was not run against a real S3-compatible service), WAL archiving or point-in-time recovery,
> a measured recovery time on realistic data, and a drill on a Linux host. Treat the production procedure as untested until your own drill is recorded in the
> [checklist](#restore-test-checklist). An earlier, manual drill (same day) is kept [below](#earlier-manual-drill-performed-on-2026-10-21).

## What the tooling does

| Piece                                    | What it does                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| ---------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ops/backup.sh`                          | One run = one backup. Refuses a role that does not bypass row-level security. Reads the row counts and the dump from **one snapshot**, so they agree even while the system is written to. `pg_dump -Fc`, piped straight into `age` (no plaintext file). Writes `orderloop-<UTC stamp>.dump.age` and `.manifest.json` (sizes, `sha256` of the encrypted file, migration version, per-table row counts, forced-RLS count, `SECURITY DEFINER` function list, `pg_dump` and server versions, a fingerprint of the key it was encrypted to; no secret). Optionally copies both files to an S3-compatible remote with `rclone`. Applies retention. Records the success time in Redis for the API's backup-age metric. Logs one JSON object per line; any failure is `backup.failed` on stderr and a non-zero exit (1 failed, 2 configuration, 3 dump fine but upload failed). |
| `ops/backup-loop.sh`                     | The `backup` container's process: a daily run at `BACKUP_AT` (UTC), an immediate run at start if no backup is younger than `BACKUP_MAX_AGE_HOURS`, a retry every `BACKUP_RETRY_MINUTES` after a failure, and a re-report of the newest backup to Redis at start (Redis is not durable).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `ops/backup-health.sh`                   | The container healthcheck: unhealthy when the newest backup is older than `BACKUP_MAX_AGE_HOURS` (26 h), or when none exists after a two-hour start-up grace.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `ops/restore-drill.sh`                   | Restores the newest backup (or a file you name) into a **scratch database** and verifies it; see [the drill](#the-restore-drill). Never touches the live database; always drops the scratch one.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| the `app_backup` and `app_monitor` roles | Created by the migrate job ([`deploy/setup-ops-roles.mjs`](../../deploy/setup-ops-roles.mjs)); see [the backup role](#the-backup-role).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |

**Encryption is `age` with a public recipient key** (chosen over `openssl enc`: authenticated, so a corrupted or truncated file is detected on decryption, and the backup host holds only the public key). `./deploy/generate-secrets.sh`
creates the key pair: the public half goes in `deploy/.env` (`BACKUP_AGE_RECIPIENT`), the **private half in `deploy/backup-age-identity.txt`, which you must move off the host and keep safely (two custodians, with `COURIER_CREDENTIALS_KEY` kept somewhere else)**. Without it no backup can be restored. A stolen
backup volume is useless without it; a lost identity file makes every backup useless.

**Retention:** the newest backup of each of the last `BACKUP_KEEP_DAILY` (7) UTC days plus the newest of each of the last `BACKUP_KEEP_WEEKLY` (4) ISO weeks; the backup just written is never deleted, a dump without a manifest is never touched. Unit-tested in `ops/tests/retention.test.sh`. These defaults are shorter than the "proposed" 14 days/8 weeks below: raise them for the pilot if disk allows.
**Backups contain personal data and outlive deletion requests by the retention period** (see [below](#backups-contain-personal-data)).

**Off-site copy** (optional): set `BACKUP_RCLONE_REMOTE=offsite:bucket/path` and the four `RCLONE_CONFIG_OFFSITE_*` variables in `deploy/.env.example`. A failed upload keeps the local copy, logs `backup.failed` with `step: upload` and exits 3, and the success time is **not** reported. Only the encrypted file and the manifest are uploaded.
**Not run against any real S3-compatible service**; the code path was only syntax-checked.

## The backup role

Every tenant table has `FORCE ROW LEVEL SECURITY`, so a dump taken by the table owner, or with `--enable-row-security`, **silently omits every tenant's rows** (the next section shows it with numbers). The migrate job therefore creates `app_backup`:
`LOGIN NOSUPERUSER BYPASSRLS`, member of `pg_read_all_data`, `CONNECT` on the database. It can read everything and write nothing; it is not the owner and not a superuser. `ops/backup.sh` checks `rolsuper OR rolbypassrls` for the role it connects as before doing anything and **refuses to run as any other** (tested: as `app_user` it exits 1 with `role app_user does not bypass row-level security`).
Its password is `DATABASE_BACKUP_PASSWORD`. If your PostgreSQL has no superuser (a managed service), you cannot create such a role yourself: use the provider's snapshots/PITR, or ask which role can dump past forced RLS and verify with the drill before trusting it.

## The restore drill

```bash
docker compose -f deploy/docker-compose.yml --profile ops run --rm \
  -v "$PWD/deploy/backup-age-identity.txt:/run/secrets/age-identity:ro" drill          # newest backup
# or a particular file:  ... drill restore-drill.sh /backups/orderloop-<stamp>.dump.age
```

It needs the age **private** key (mounted for the run only), the PostgreSQL superuser password (`DRILL_ADMIN_PASSWORD`, set from `POSTGRES_PASSWORD` by the compose file) and the `app_user` password. Steps and checks, each printed `[PASS]` or `[FAIL]`, final `RESULT: PASS|FAIL`, exit 0 only if all passed:

1. **file checksum**: `sha256` of the `.dump.age` equals the manifest's.
2. **decrypt + restore**: `age -d | pg_restore --exit-on-error` into a new database `orderloop_drill_<time>` owned by `app_migrator` (streamed, no plaintext file).
3. **migrations**: the restored `_prisma_migrations` ends at the manifest's version, the same number applied, none unfinished (the equivalent of `prisma migrate status`).
4. **row counts**: every table's count equals the manifest's (taken from the same snapshot as the dump), no table missing or extra.
5. **forced RLS**: every table with a `tenant_id` column has row-level security enabled **and** forced, and the forced count equals the manifest's.
6. **definer functions**: the `SECURITY DEFINER` functions equal the manifest's list and each pins its `search_path`.
7. **tenant isolation**, connecting as `app_user` to the restored copy, on the tenant table with the most rows: with no tenant context 0 rows are visible; with one tenant's context exactly that tenant's rows; with a random other tenant's id 0 rows.
   **A backup with no tenant rows at all fails this check** (that is what an RLS-filtered dump looks like), unless `DRILL_ALLOW_EMPTY=1` for a system that really holds no data yet.

Then the scratch database is dropped. Not covered by the drill: the application's behaviour on the restored data (start a scratch API per section 6, step 7), `COURIER_CREDENTIALS_KEY` correctness, restoring on a cluster where the roles do not exist yet (run the migrate job, or `pnpm db:setup`, first), and timing on real volumes.

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
   method the project provides and has exercised (locally): `ops/backup.sh` and `ops/restore-drill.sh` above.

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

So: **back up as a superuser or a dedicated backup role with `BYPASSRLS`**: the migrate job creates exactly that, `app_backup` (`pg_read_all_data` **and** `BYPASSRLS`; `pnpm db:setup` alone does not).
Reproduced again on 2026-10-21 with the compose stack (2 businesses, 4 products): `pg_dump --data-only --table=products --enable-row-security` as `app_migrator` produced **0** rows, as `app_backup` **4**.
Never use `--enable-row-security`
for backups. On managed PostgreSQL where no superuser exists, use the provider's snapshot/PITR, or confirm with the provider
which role can dump past forced RLS, and verify with the row-count check in [section 6](#6-restore-drill-procedure) before
trusting it.

### Take a logical backup by hand

`docker compose exec backup backup.sh` takes one now with the provided tooling. For another setup (or a manual fallback), run from a machine that can reach the database; `--format=custom` is compressed and lets `pg_restore` select and parallelise.
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

`pnpm db:setup` (in the compose deployment, the migrate job) creates the cluster-level roles (script: `packages/db/scripts/setup-roles.mjs`, run with
`DATABASE_ADMIN_URL`; the migrate job also creates `app_backup` and `app_monitor`, which a restore does not need). The dump references them in its ACLs, so on a **new cluster** run `pnpm db:setup` (or create the two roles
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

**`ops/restore-drill.sh` automates the file check, the restore and steps 3 to 6 below (and the migration check in step 6, and the tenant-isolation part of step 5) and prints PASS or FAIL ([the drill](#the-restore-drill)); do the manual steps for what it does not cover (step 7) and when you restore by hand.**
The expected numbers quoted in the manual steps are from the schema of the earlier manual drill (20 migrations); the schema now has 23 migrations, 39 forced-RLS tables and 17 `SECURITY DEFINER` functions (the drill reads these from the manifest, so it needs no numbers typed in).

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
- Do not start a restored copy with live outbound integrations enabled (`META_MODE=live`, `TIKTOK_MODE=live`, `PUSH_PROVIDER=expo`, real SMTP, real courier credentials): it will send real email, pushes and may touch real courier accounts.
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

**Evidenced by the local run on 2026-10-21** (a real deployment still has to do each of these itself): backup job exists and runs, its age is a metric and a healthcheck; the backup role gives a complete dump (row counts match); the dump is encrypted;
drill restore into a scratch database with all checks; isolation as `app_user`; `migrate status` equivalent; scratch database dropped. **Not evidenced:** off-host storage, two named key custodians, a measured RTO, a smoke test of a scratch API on the restored copy, PITR, Redis replacement, a written retention and deletion statement.

## Drill performed on 2026-10-22 (local)

Re-run after a session restart, from scratch (images rebuilt, new throwaway project `orderloop-smoke`, fresh secrets and database, seeded through the API: 2 businesses, 4 products), by `./deploy/smoke-test.sh` (all sections, exit 0). Same limits as the 2026-10-21 run below: laptop, Docker Desktop, tiny data, no real host, no real off-site upload. Real output, container-start lines trimmed:

```
$ docker compose exec backup backup.sh
{"level":"info","service":"orderloop-backup","event":"backup.completed","file":"orderloop-20261022T082748Z.dump.age","bytes":250750,"sha256":"1ea45318...72f0","migration":"20261031100000_data_deletion","tables":45,"rows":51,"upload":"none",...}
manifest: migrations_applied 23, rls_forced_tables 39, definer_functions 17, tables 45, rows 51, tenants 2, products 4, users 2

owner role (app_migrator, --enable-row-security): rows dumped from products = 0
backup role (app_backup):                         rows dumped from products = 4

$ docker compose --profile ops run --rm -v .../backup-age-identity.txt:/run/secrets/age-identity:ro drill
drill: orderloop-20261022T082748Z.dump.age  (backup made 2026-10-22T08:27:48Z)
[PASS] file checksum          sha256 matches the manifest (250750 bytes)
[PASS] decrypt + restore      restored into scratch database orderloop_drill_20261022082749
[PASS] migrations             23 applied, latest 20261031100000_data_deletion, none unfinished
[PASS] row counts             all 45 tables match the manifest (51 rows)
[PASS] forced RLS             39 tables with forced row-level security (manifest: 39); all 38 tenant tables are covered
[PASS] definer functions      17 SECURITY DEFINER functions, same as the manifest, all with a pinned search_path
[PASS] tenant isolation       as app_user on audit_logs (8 rows, 2 tenant(s)): no context -> 0, own tenant -> 5 of 5, another tenant -> 0
scratch database orderloop_drill_20261022082749 dropped
RESULT: PASS

-- failure: wrong age key
[PASS] file checksum          sha256 matches the manifest (250750 bytes)
[FAIL] decrypt                age could not decrypt the backup (wrong key, or the file is corrupt): age: error: no identity matched any of the recipients
RESULT: FAIL (1 check(s) failed)                        exit code 1
-- failure: corrupted copy, manifest mismatch
[FAIL] file checksum          sha256 differs from the manifest: the file is corrupt or was altered     -> RESULT: FAIL, exit code 1
-- failure: corrupted copy with the checksum "fixed"
[FAIL] decrypt                ... age: error: failed to decrypt and authenticate payload chunk          -> RESULT: FAIL, exit code 1
-- failure: backup.sh as app_user
{"level":"error","event":"backup.failed","step":"preflight","message":"role app_user does not bypass row-level security: ..."}      exit code 1
-- failure: no encryption key
{"level":"error","event":"backup.failed","step":"config","message":"BACKUP_AGE_RECIPIENT is not set: refusing to write an unencrypted backup"}   exit code 2
orderloop_backup_last_success_timestamp_seconds 1792657668        (API /metrics)
```

The same run, in the same script, re-confirmed: migrate job exit 0 (23 migrations), every service healthy, HTTPS through Caddy (internal CA), `/metrics` 404 through the proxy and token-protected inside, 403 `registration_closed` then 201 for an allowlisted sign-up, a product created, the verification email delivered over STARTTLS, all 6 Prometheus targets up, and `WorkerDown` and `WorkerHeartbeatStale` firing and reaching Alertmanager after the worker was stopped (no receiver configured). Also re-run: `promtool check rules` (16 rules) and `promtool test rules` (SUCCESS), `docker compose config` with and without profiles, and the unit tests (contracts 97, observability 17, worker 42, api 114, repository scripts 22).

## Drill performed on 2026-10-21 (local)

Run by `./deploy/smoke-test.sh --only backup` on a developer laptop (Docker Desktop, arm64; PostgreSQL 16.15, `age` 1.1.1, `pg_dump` 16.15), against a **throwaway** compose project (`orderloop-smoke`) that was
seeded **through the API** (two businesses, four products, fictional data; the developer's own database was not read), then torn down with `down -v` for that project only. It proves the procedure and the database-level
properties on a tiny database, **not production volume, timing or a real host**. All output below is the real output of that run (container-start lines and the long JSON lines trimmed).

**1. A real backup**

```
$ docker compose exec backup backup.sh
{"level":"info","service":"orderloop-backup","event":"backup.completed","file":"orderloop-20261021T155156Z.dump.age","bytes":250743,
 "sha256":"4c08bd90...7bdd","migration":"20261031100000_data_deletion","tables":45,"rows":51,"upload":"none","removed_old":1,"kept":1,"seconds":1}
-rw------- 1 postgres postgres 250743 orderloop-20261021T155156Z.dump.age
-rw------- 1 postgres postgres   2749 orderloop-20261021T155156Z.manifest.json
manifest: migrations_applied 23, rls_forced_tables 39, definer_functions 17, tables 45, rows 51, tenants 2, products 4, users 2
```

**2. The row-level-security trap, with data in the database**

```
owner role (app_migrator, --enable-row-security): rows dumped from products = 0
backup role (app_backup):                         rows dumped from products = 4
```

**3. The drill: PASS**

```
$ docker compose --profile ops run --rm -v .../backup-age-identity.txt:/run/secrets/age-identity:ro drill
drill: orderloop-20261021T155156Z.dump.age  (backup made 2026-10-21T15:51:57Z)
[PASS] file checksum          sha256 matches the manifest (250743 bytes)
[PASS] decrypt + restore      restored into scratch database orderloop_drill_20261021155158
[PASS] migrations             23 applied, latest 20261031100000_data_deletion, none unfinished
[PASS] row counts             all 45 tables match the manifest (51 rows)
[PASS] forced RLS             39 tables with forced row-level security (manifest: 39); all 38 tenant tables are covered
[PASS] definer functions      17 SECURITY DEFINER functions, same as the manifest, all with a pinned search_path
[PASS] tenant isolation       as app_user on audit_logs (8 rows, 2 tenant(s)): no context -> 0, own tenant -> 5 of 5, another tenant -> 0
scratch database orderloop_drill_20261021155158 dropped

RESULT: PASS
```

**4. Failure cases: each one must fail loudly (non-zero exit, `RESULT: FAIL`, or an error), and did**

```
-- the wrong age key
drill: orderloop-20261021T155156Z.dump.age  (backup made 2026-10-21T15:51:57Z)
[PASS] file checksum          sha256 matches the manifest (250743 bytes)
[FAIL] decrypt                age could not decrypt the backup (wrong key, or the file is corrupt): age: error: no identity matched any of the recipients
scratch database orderloop_drill_20261021155159 dropped
RESULT: FAIL (1 check(s) failed)                                   exit code 1

-- a copy of the backup with one byte changed (checksum no longer matches the manifest)
drill: corrupt-a.dump.age  (backup made 2026-10-21T15:51:57Z)
[FAIL] file checksum          sha256 differs from the manifest: the file is corrupt or was altered
RESULT: FAIL (1 check(s) failed)                                   exit code 1

-- the same corruption with the manifest's checksum "fixed" to match (only the encryption can notice)
[PASS] file checksum          sha256 matches the manifest (250743 bytes)
[FAIL] decrypt                age could not decrypt the backup (wrong key, or the file is corrupt): age: error: failed to decrypt and authenticate payload chunk
scratch database orderloop_drill_20261021155201 dropped
RESULT: FAIL (1 check(s) failed)                                   exit code 1

-- backup.sh as a role that is subject to row-level security (app_user)
{"level":"error","service":"orderloop-backup","event":"backup.failed","step":"preflight","message":"role app_user does not bypass row-level security: a dump by it would
 silently omit every tenant's rows. Use app_backup (BYPASSRLS) or a superuser.","seconds":0}                                                       exit code 1

-- backup.sh with no encryption key configured
{"level":"error","service":"orderloop-backup","event":"backup.failed","step":"config","message":"BACKUP_AGE_RECIPIENT is not set: refusing to write an unencrypted backup","seconds":0}   exit code 2
```

An earlier run of the same script, against a stack **with no data**, ended `[FAIL] tenant isolation ... the backup holds NO tenant rows` (the intended behaviour for an empty or RLS-filtered dump). The first full run also found two bugs in the tooling that
were fixed before the output above: `redis-cli -u redis://:password@...` is refused by Redis 7 (the backup time was not being reported to the API; fixed by parsing the URL), and a failing pipeline fired the error trap before its specific message (the wrong-key case reported "unexpected error" instead of "decrypt").

**5. The backup is visible to monitoring**

```
orderloop_backup_last_success_timestamp_seconds 1792597917        (from the API's /metrics)
healthcheck: ok: newest backup orderloop-20261021T155156Z.dump.age is 0 min old
```

**What this did not exercise:** restoring on a different host or cluster, a real off-site upload, the age private key held somewhere other than the laptop's temp directory, a database larger than a few hundred KB, timing, WAL/PITR, Redis loss, and the application started against the restored data.

## Earlier manual drill (performed on 2026-10-21)

This was done by hand, before the tooling above existed. Performed on a developer laptop with the dev Docker PostgreSQL (`orderloop-postgres-1`, image `postgres:16`, `pg_dump` 16.15),
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
