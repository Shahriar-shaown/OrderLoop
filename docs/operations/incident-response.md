# Incident response

A practical runbook for a **controlled pilot** with a handful of businesses. It assumes the logging, health endpoints and
admin access described in [monitoring.md](monitoring.md), and the backup procedures in [backup-and-restore.md](backup-and-restore.md).
No incident exercise has been run by the project. Names, phone numbers and channels below are **placeholders** to fill in before the pilot.

## 1. Severity levels

| Level    | Definition (pilot)                                                                                                                                                       | Response target (proposed)       | Update cadence |
| -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------- | -------------- |
| **SEV1** | Data exposed across businesses or leaked credentials; wrong or duplicate courier bookings in progress; data loss; whole service down; wrong money figures being acted on | Acknowledge in 15 min, all hands | every 30 min   |
| **SEV2** | A core flow broken for some or all businesses (sign-in, orders, stock, courier booking) or a background system stopped (worker, Meta ingestion) with no data harm        | Acknowledge in 30 min            | every 60 min   |
| **SEV3** | Degraded or cosmetic: slow pages, one business affected by a bad integration setting, a delayed notification                                                             | Next working day                 | as needed      |

When unsure between two levels, pick the higher one and downgrade later.

## 2. Roles for a pilot

| Role                    | Does                                                                                        | Who (fill in)   | Backup (fill in) |
| ----------------------- | ------------------------------------------------------------------------------------------- | --------------- | ---------------- |
| **Incident commander**  | Decides severity, owns the timeline, makes stop/rollback calls, keeps others on task        | `<name, phone>` | `<name, phone>`  |
| **Operations engineer** | Hands on the systems: logs, database, deploy, rollback                                      | `<name, phone>` | `<name, phone>`  |
| **Communications**      | Writes the updates to pilot businesses and internal channel; nobody else messages customers | `<name, phone>` | `<name, phone>`  |
| **Scribe**              | Keeps the timeline (UTC), commands run, decisions                                           | `<name>`        | `<name>`         |
| **Data/privacy owner**  | Decides on notification duty and evidence handling for data incidents                       | `<name>`        | `<name>`         |

**Escalation contacts (placeholders):** hosting provider support `<url/phone/account id>`; database provider support `<...>`; domain/DNS `<...>`;
Pathao merchant support `<...>`; Steadfast merchant support `<...>`; Meta developer support / app dashboard owner `<...>`; SMTP provider `<...>`;
Expo/EAS account owner `<...>`; legal counsel `<...>`; pilot business contacts `<one per business>`.
Incident channel: `<chat channel>`. Status page: none exists.

## 3. First 15 minutes (any incident)

1. **Acknowledge** and name the incident commander. Note the time in UTC and open the timeline.
2. **Assess** with three commands:
   ```bash
   curl -s -o /dev/null -w '%{http_code}\n' https://<api>/health/live
   curl -s https://<api>/health/ready                       # {"status":"ok"|"degraded","checks":{"postgres","redis"}}
   <your log tool>: status>=500 in the last 15 min; worker events automation.tick / meta.* / [worker] errors
   ```
3. **Set severity** (section 1). SEV1: stop the bleeding first (section 4), explain later.
4. **Ask "did we change something?"** The last deploy, migration, env change, key rotation, DNS/certificate change, or provider incident. Roll back before diagnosing if the change is the likely cause ([bad deploy](#bad-deploy-rollback)).
5. **Preserve evidence** before restarting or cleaning up: save the relevant log window (all services), `SELECT now()`, the output of `migrate:status`, and for data incidents the actions in section 4.6.
6. **First communication** within the response target (template in section 5) to affected pilot businesses.
7. Decide **who is looking at what**; do not let two people change the same system at once.

Do not: restart everything "to see", delete queue keys, edit rows by hand without a backup, disable RLS, or paste logs/tokens into public chat.

## 4. Runbooks

Commands assume access to the secrets and hosts of your deployment ([deployment.md](deployment.md)).

### API down

Symptoms: probe fails, `5xx` flood, web shows "cannot reach OrderLoop".

1. `curl /health/live`. No answer: the process or the proxy is down. Check the supervisor/container state, proxy and TLS certificate, DNS, then the API log.
2. Answers `live` but `/health/ready` is `503`: it is a dependency, go to [DB down](#database-down) or [Redis down](#redis-down).
3. Process crash-loops: read the **first** log lines at start-up. The API validates its environment and exits listing every bad variable (values are not printed). Typical causes: `NODE_ENV` missing, `JWT_PRIVATE_KEY`/`JWT_PUBLIC_KEY` missing or only one set, `MAIL_PROVIDER=console` in production, `COURIER_CREDENTIALS_KEY` not exactly 32 bytes of base64, `META_MODE=live` without all of `META_APP_ID`, `META_APP_SECRET`, `META_WEBHOOK_VERIFY_TOKEN`, `META_GRAPH_VERSION`, `API_PUBLIC_URL`, `COURIER_CREDENTIALS_KEY`, `API_PUBLIC_URL` not https.
4. After a deploy: roll back to the previous release tag ([bad deploy](#bad-deploy-rollback)).
5. 429 for everyone behind a proxy: `TRUST_PROXY` is 0 and every client shares the proxy's address; set it to the hop count and restart.
6. Verify recovery with the smoke test ([deployment.md](deployment.md#12-smoke-test-after-deploy)). Web and mobile show offline banners and recover on their own; nothing is queued on the phone (writes are refused while offline), so users re-enter whatever failed.

### Database down

Symptoms: `/health/ready` 503 with `postgres: down`, 5xx on every data route, worker log errors.

1. Check the provider's status and the instance: disk full, out of connections (`max_connections` vs the API pool and worker pool of 5), failed over, maintenance.
2. **Do not delete WAL, files or "clean up" to free space** on a database you may need to recover. Free space by expanding storage.
3. If the instance is lost or corrupted: SEV1. Decide: provider failover/PITR (preferred, if configured) or restore the latest dump ([restore](backup-and-restore.md#5-restore-roles-and-commands)). Tell pilot businesses the **RPO** (what time of data may be lost) before you restore.
4. Stop the worker and API before repointing to a restored database. Start the worker only after `migrate:status` is clean.
5. After recovery: check `/health/ready`, sign in, create a test order in the test business. Redis-backed sweepers re-queue unfinished imports, Meta events and deliveries within minutes (see [Redis section](backup-and-restore.md#4-redis)); check the worker log for `automation.tick`.
6. Reconcile what the businesses did between the restore point and the failure (orders, stock movements, courier bookings made at the courier but not in OrderLoop): ask them, and compare with the couriers' panels. Couriers may hold parcels OrderLoop no longer knows about.

### Redis down

Symptoms: `/health/ready` `503` with `redis: down`; background work stops; sign-in lockout fails open.

1. Restart or replace Redis. No backup is needed or useful.
2. **If your load balancer uses `/health/ready` to route traffic, it has already taken the API out of rotation even though most routes work without Redis.** Consider routing on `/health/live` and alerting on `/health/ready`.
3. While Redis is down: orders, stock and auth still work; new-order notifications are not queued (the 5-minute catch-up announces them later); CSV imports are saved but wait; automation and Meta processing pause; failed-job history is lost on a wipe.
4. When it returns: restart the worker so it re-registers its schedulers; confirm `automation.tick` every minute. The sweepers re-queue pending imports (after 60 s), received Meta events and pending deliveries (after a minute). **A CSV import that was `RUNNING` when Redis was lost is not swept**: ask the seller to upload it again (from reading the code, not tested).
5. If Redis came back empty and you hold the failed sets for evidence, there are none; use PostgreSQL (`automation_runs`, `notification_deliveries`) instead.

### Worker stuck or queue backlog

Symptoms: no `automation.tick` for 3+ minutes, deliveries `pending`, Meta events `received`, imports `PENDING`, queue lengths rising.

1. Is the worker process running? Restart it with `SIGTERM` (it finishes the current job and exits; `SIGKILL` is safe too: BullMQ redelivers stalled jobs and the claims are idempotent).
2. Read the worker log from the start: Redis or PostgreSQL connection errors, `[worker] ... failed to start: ...` (same environment validation as the API; **the worker needs the same `PUSH_PROVIDER`, `SMS_PROVIDER`, `WHATSAPP_PROVIDER`, `MAIL_*`, `META_*` and `COURIER_CREDENTIALS_*` values as the API**).
3. One slow or poison job: look at `bull:<queue>:failed` ([monitoring.md](monitoring.md#queues-redis-bullmq)) and the failed runs/deliveries endpoints. Retry through `POST /v1/automation/runs/:id/retry` or `.../deliveries/:id/retry` (idempotent). Permanent failures (`permanent:invalid_recipient`) will not retry by themselves.
4. Scale: run a second worker process (same environment). There is one tick scheduler however many workers run, and each process runs one import at a time; automation evaluation concurrency is 4 and delivery 5.
5. Do not delete queue keys by hand; the database is the source of truth and the sweepers rebuild queue state.
6. Reports whose local day has ended are not sent late (documented limit); tell the business.

### Courier API outage or wrong bookings

Facts that shape the response (from [../couriers.md](../couriers.md)): booking is claimed in the database before the courier is called; an unknown outcome becomes `booking_uncertain` and is never retried automatically; Pathao and Steadfast have no documented cancel endpoint, so cancelling is done in their panel and then recorded in OrderLoop; nothing was verified against a real courier account by the project.

**Courier outage** (`502 courier_unavailable`, `422 courier_rejected`, timeouts):

1. Confirm on the courier's own status page/panel. Tell businesses to **stop booking** that courier; offer manual booking in the courier's panel.
2. Disable the connection if bookings keep failing: `PATCH /v1/couriers/:provider` `{ "enabled": false }` (`couriers:manage`). **Do not `DELETE` it**: that removes the saved credentials.
3. Shipments in `booking_uncertain` block the order and its cancellation until a person opens the courier's panel, looks for the reference (`OL-<order number>`, `OL-<n>-2` on a second attempt) and records what they saw (**Settle this booking**). Do this for each one **before** the courier comes back, never "retry".
4. When the courier returns: use **Check status now** on affected shipments; webhooks missed during the outage are not replayed by OrderLoop (there is no poller).

**Wrong or duplicate bookings** (SEV1 when parcels are being collected):

1. Disable the connection (above). Identify the parcels: shipments created in the window (`shipments` by `created_at`, courier reference, order number).
2. For each wrong parcel: cancel in the courier's panel, then in OrderLoop **Mark cancelled at the courier** (needs `couriers:manage`: it re-opens the order for booking, so a wrong click can create a second parcel).
3. Check cash impact: COD amounts, courier fees; review the finance discrepancies screen after the courier's statement arrives.
4. Root-cause before re-enabling. Re-enable on one business first, one parcel, and watch it.

### Webhook flood or signature failures

Meta (`POST /v1/webhooks/meta`) and couriers (`POST /v1/webhooks/couriers/:provider/:tenantId/:connectionId`) are public routes authenticated by signature or secret.

1. Signature failures (`status 401`, `warn`): a wrong `META_APP_SECRET` (after a rotation, set on the worker but not the API, or the reverse), a proxy rewriting the body, or an attacker probing. Meta: `Webhooks Disabled` after an hour of failures; messages in between are lost (no history API). Fix the cause, then **reconnect the Page/account** so it is subscribed again.
2. Flood: the Meta webhook has a per-address budget of 1200/minute and a 512 KB body cap; other routes 120/minute per IP. Courier webhooks answer `401` identically for wrong tenant, connection, missing or wrong secret. Block abusive sources at the proxy/firewall; do not widen rate limits.
3. A courier webhook secret suspected leaked: change the secret in OrderLoop and in the courier's panel together (Settings, Couriers). An attacker holding it could post fake status updates for that business's parcels; updates cannot confirm, cancel, restock or reopen an order, but can mark it delivered.
4. Check the load: unprocessed events are stored first (`social_events`) and queued second, so a flood fills the database, not only Redis; `META_RETENTION_DAYS` purges old events hourly.

### Suspected credential or token leak

First decide **what** leaked, then rotate only that, in this order of speed. Record every rotation in the timeline.

| Leaked                                               | Do                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| ---------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| One user's session or password                       | Password reset (ends every session of that user), or disable the account (`users.disabled_at`, an admin SQL change; a disabled account is refused on every request). Check `auth.login` / `auth.token_reuse_detected` in the business's audit log.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| **JWT private key**                                  | Generate a new pair with `pnpm --filter @orderloop/api auth:generate-keys`, set `JWT_PRIVATE_KEY` and `JWT_PUBLIC_KEY`, restart the API. Every outstanding access token (15 min) stops verifying at once; refresh tokens survive. A leaked key lets its holder sign tokens, but the guard re-reads the session and membership from the database on every request, so a forged token works only if it names a real, active session id (a random UUID) with the matching user and business; do not treat that as a reason to delay the rotation. To force everyone to sign in again as well: `UPDATE sessions SET revoked_at = now(), revoked_reason = 'incident' WHERE revoked_at IS NULL;` as the admin role, after taking a backup.                                                                                                                                                                                                                                                                                                           |
| **All sessions** (any doubt)                         | `pnpm sessions:revoke --all` prints how many live sessions would be revoked (dry run); add `--yes` to do it. Narrower: `--user <email>`, or `--tenant <business id>` (every member of that business). Needs `DATABASE_ADMIN_URL`; sets `revoked_at` with reason `incident`, prints one JSON log line with counts (no tokens). Take a backup first if unsure. SQL fallback: the `UPDATE sessions ...` statement above.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| **`COURIER_CREDENTIALS_KEY`**                        | The key seals courier credentials, courier webhook secrets and Meta page tokens. Procedure documented in `.env.example` and [../couriers.md](../couriers.md#where-credentials-live): set a **new** `COURIER_CREDENTIALS_KEY` and a new `COURIER_CREDENTIALS_KEY_ID` (for example `k2`) and move the old key into `COURIER_CREDENTIALS_OLD_KEYS=k1:<old key>`. **That alone does not protect you:** old values stay encrypted under the compromised key until each business re-saves them, and **no re-encryption tool exists in the code**. If the database (or a dump) was also exposed, treat every credential as compromised: rotate them at the couriers (Pathao client secret, Steadfast keys, webhook secrets), have businesses enter the new ones (re-saving seals them under the new key), disconnect and reconnect Meta, and only then remove the old key from `COURIER_CREDENTIALS_OLD_KEYS` (rows still sealed under it become unreadable: that is the intended end state). Give API **and worker** the same values. Not rehearsed. |
| **`META_APP_SECRET`**                                | Reset it in the Meta app dashboard, set `META_APP_SECRET` on the API **and** the worker, restart both (webhooks signed with the old secret get 401 meanwhile; Meta retries). Saved Page tokens are not invalidated by a secret change; run the health check or reconnect. The secret also signs the OAuth state and the deauthorize/data-deletion callbacks.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `META_WEBHOOK_VERIFY_TOKEN`                          | Set the new value in the Meta dashboard first, then in the environment; it is used only when (re)subscribing.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| A Meta **page token** or a connection's person       | Disconnect the connection: `DELETE /v1/integrations/meta/connections/:id` (`integrations:manage`; deletes the stored token) and, in Meta, remove the app from the Page/Instagram settings (the person can do it at Meta). Reconnect later.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| **All Meta connections**                             | Disconnect each (above), reset `META_APP_SECRET`, redeploy; consider `META_MODE=mock` until investigated.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| A TikTok **shop connection** or **all of them**      | Disconnect: `DELETE /v1/integrations/tiktok-shop/connections/:id` (`integrations:manage`; deletes the sealed tokens). For all: disconnect each, reset `TIKTOK_APP_SECRET` (it signs requests, webhooks and the sign-in state), redeploy; consider `TIKTOK_MODE=mock` until investigated. In TikTok Shop, the seller can remove the app. Reserved stock of open orders stays reserved: reconnect later or resolve the orders.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| Courier credentials of one business                  | Rotate at the courier, then `PATCH /v1/couriers/:provider` with the new values (write-only), or `{ "enabled": false }` meanwhile.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| Database credentials                                 | Change the role password at the database, update `DATABASE_URL` / `DATABASE_MIGRATION_URL` / `DATABASE_ADMIN_URL`, restart. If `app_migrator` or the admin leaked, review `pg_stat_activity` and the logs for the period.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| SMTP / `EXPO_ACCESS_TOKEN`                           | Rotate at the provider, update the secret on API and worker, restart.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| A `.env` or dump leaked publicly (git, chat, bucket) | Treat as **all of the above**, plus the data exposure runbook below.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |

Afterwards: find out how it leaked, search the repository history (`git log -S`) and CI logs for the value, and write the review.

### Suspected cross-tenant data exposure

SEV1. The design relies on three layers: the tenant id coming only from the verified token, forced row-level security on 39 tenant tables, and an
`app_user` role that cannot bypass it. A real exposure would mean one of those failed.

1. **Stop**: if the reproduction is a specific endpoint, take it out (proxy rule returning 503 for that path) or stop the API. Prefer losing availability to continuing the exposure.
2. **Preserve evidence**: copy the log window (requests with `userId`, `tenantId`, `path`, `requestId`), the exact request and response if available, the `audit_logs` for the involved businesses, and a database snapshot or a dump taken by the backup role. Do not "fix" data before copying.
3. **Scope** it: which businesses, which tables or routes, which time window, what fields (customer names, phones, addresses are personal data; secrets are sealed). Query logs by `path` and `tenantId` mismatches.
4. **Verify the isolation controls on the running database** (as the admin role, read-only):
   ```sql
   SELECT count(*) FILTER (WHERE relrowsecurity AND relforcerowsecurity) AS forced FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND relkind='r';  -- 39 on the 2026-10-21 schema
   SELECT rolname, rolsuper, rolbypassrls FROM pg_roles WHERE rolname IN ('app_user','app_migrator');  -- both false
   ```
   and confirm the application connects as `app_user`, not as a superuser or owner (`SELECT current_user` through a one-off check of the connection URL in the deployment). A deployment that points `DATABASE_URL` at a superuser or the owner role silently turns RLS off for the application.
5. Reproduce on a **copy**: run the isolation suite (`pnpm test:integration`, which includes `apps/api/test/tenant-isolation.e2e.test.ts`) on a throwaway database, then write a failing test for the leak.
6. **Fix, deploy, verify**, then decide on notification with the data/privacy owner and legal counsel: which businesses, what data, when. Use the template in section 5. The project makes **no claim of legal compliance**; the notification duty depends on your jurisdiction and contracts.
7. Review logs and sessions for the affected businesses (revoke sessions if a credential could have been seen).

### Bad deploy rollback

1. Declare it; freeze further deploys.
2. Roll the application back to the previous tagged release (re-deploy the previous build artifact/image for api, worker and web; there is no automated rollback in the repository).
3. If the release included a migration: it must have been additive ([migrations.md](migrations.md#rollback-strategy)); leave the schema. If it was not compatible, fix forward or restore the pre-deploy backup (data since then is lost).
4. Roll the **web** and **API** back together if the API contract changed (`docs/openapi.json` differs). A mobile build in the field cannot be rolled back: the API must stay compatible with the released app versions.
5. Run the smoke test; confirm the worker is on the same version and `automation.tick` is logging.
6. Open the post-incident review.

### Financial discrepancy found

Examples: Outstanding COD or estimated profit disagrees with records; a settlement import matched wrong; stock does not match.

1. **Stop acting on the figure.** Tell the business the number is under review. Estimated profit is an estimate by design ([../finance.md](../finance.md)); the dashboard's profit is gross and the finance summary's is net (known, [../known-issues.md](../known-issues.md)); manually recorded courier charges plus an imported statement can double-count.
2. Reproduce from records: orders, shipments, `settlement_batches`/`settlement_items`, `discrepancies`, `manual_costs`, the audit trail (`settlement.*`, `finance.*` actions; manual decisions keep their reason).
3. Stock: the ledger `stock_movements` is append-only and replayable per (variant, location) (`docs/database.md`); compare the sum of deltas to `stock_levels`.
4. Money is integer paisa; check the `CHECK` constraints did not reject writes (errors in the API log).
5. Fix by a reviewed correction (a new adjustment/cost/discrepancy resolution through the application), **not** by editing rows. Settlement imports are idempotent: re-importing the same statement creates no duplicates.
6. Tell the business what changed and keep the evidence.

### Data deletion request

> **Update:** the product now has the three capabilities this runbook said were missing: a customer can be erased (`POST /v1/customers/:id/erase`), a person can delete their own account (`POST /v1/me/delete`), and an owner can delete a business (`POST /v1/tenant/delete-request`, then the worker's hourly purge after the grace period). Point the requester at them and keep the output with the request; only a request nobody in the app can make (no owner left) needs the manual steps below. What each removes, keeps and cannot reach, and the SQL to run a purge by hand: [../privacy-and-deletion.md](../privacy-and-deletion.md). These are technical capabilities, not a compliance statement. The text below predates them and is kept for the cases they do not cover.

There are two paths. **Neither a tenant-wide nor a per-customer deletion feature exists in the application** (the API has no endpoint to delete a business, a customer or an order; orders are never deleted by the Meta purge). Everything below the Meta callbacks is a manual, reviewed operation that has **not been built or tested**.

**A. Meta data deletion callback (automatic).** Meta posts a signed request to `https://<api>/v1/webhooks/meta/data-deletion` (and `/deauthorize` on removal of the app). OrderLoop verifies the signature with `META_APP_SECRET`, disconnects the person's connections, deletes stored tokens, **deletes the stored Meta events and drafts** for those connections (or for a customer id seen in conversations), writes an `integration.data_deleted` audit row (ids only), and answers `{url, confirmation_code}`; `GET /v1/webhooks/meta/data-deletion/status?code=` reads `completed`. Orders already confirmed from a draft keep only what a person typed in the order form and are **not** deleted.
Operations: confirm the callback URLs are configured in the Meta dashboard, check the `integration.data_deleted` audit rows and the `[POST] ... data-deletion` request lines (`status` 200) after a request, and keep a note of the confirmation code given. Retention otherwise: `META_RETENTION_DAYS` (default 30) purges old events and unconfirmed drafts hourly.

**B. A business or customer asks to be deleted (manual).**

1. Verify the requester's identity and authority (owner of the business; or, for a customer, via the business that is the data controller for that customer).
2. Decide scope with the data/privacy owner and counsel: what must be deleted, what must be retained (financial records, audit log) and for how long.
3. Disable access first: `users.disabled_at`, revoke sessions, disconnect Meta, remove courier credentials (`DELETE /v1/couriers/:provider`).
4. Export what the requester is entitled to receive: orders (`GET /v1/exports/orders`), products and stock (`GET /v1/exports/products`, `/exports/stock`). There is no single "export my data" bundle.
5. Delete or anonymise by a written, peer-reviewed SQL script run by the admin role **inside a transaction after a verified backup**, in dependency order (tenant rows reference many tables through composite `(tenant_id, id)` foreign keys; `audit_logs`, `stock_movements`, `order_status_history`, `shipment_events` and `settlement_item_events` are append-only for the application role and need the owner/admin path). **No such script exists in the repository.** Count rows before and after and keep the script and output with the request.
6. **Backups still contain the data** until they expire (see retention in [backup-and-restore.md](backup-and-restore.md#backups-contain-personal-data)); logs contain ids, not names, and age out. Tell the requester this, with dates. If a backup is restored later, re-apply pending deletions.
7. Reply to the requester and record the completion date.

### Alert runbooks

Each alert in [`ops/monitoring/alerts.yml`](../../ops/monitoring/alerts.yml) links here. They come from the monitoring stack described in [monitoring.md](monitoring.md) (Prometheus and Alertmanager from the `monitoring` profile of `deploy/docker-compose.yml`). **The rules and these steps were exercised only in a local test** (`promtool test rules`, and one live alert, the worker heartbeat); thresholds are starting points for a small pilot, not tuned values. Commands assume the compose deployment: `docker compose -f deploy/docker-compose.yml ...`.

#### Alert: ApiDown

Prometheus cannot scrape the API (`up{job="api"} == 0`) for 2 minutes. That is the API process, the network, **or** a `METRICS_TOKEN` mismatch / no `METRICS_TOKEN` (then `/metrics` answers 404 or 401 and the target shows the HTTP status). Check `curl https://api.<domain>/health/live` from outside first: if the API answers there, it is the metrics token or Prometheus's network, not an outage. Otherwise follow [API down](#api-down). While `ApiDown` fires, the alerts derived from API metrics are muted (Alertmanager inhibition).

#### Alert: ApiNotReady

`orderloop_dependency_up{dependency="postgres"|"redis"} == 0`: the readiness probe (`/health/ready`, 503) cannot reach that dependency. PostgreSQL: [Database down](#database-down). Redis: [Redis down](#redis-down). `docker compose ps` and `docker compose logs postgres redis` show whether the container is unhealthy, restarting or out of disk.

#### Alert: WorkerHeartbeatStale

No worker has refreshed its heartbeat in Redis for over 2 minutes, **or** (`WorkerDown`) Prometheus cannot reach the worker's health server. Queued jobs, imports, notifications and Meta events are not processed meanwhile. Steps: `docker compose ps worker` (restarting? unhealthy?), `docker compose logs --tail 100 worker` (start-up failures print every invalid environment variable and a line with `"event":"unhandled_error"`), then follow [Worker stuck or queue backlog](#worker-stuck-or-queue-backlog). The heartbeat key lives in Redis, so a Redis outage also makes it disappear: check [Redis down](#redis-down) first when `ApiNotReady` fires too. Restart with `docker compose restart worker`; it recovers its schedulers by itself.

#### Alert: ApiHigh5xxRate

More than 5% of API requests over 5 minutes answered 5xx (with at least about 3 requests a minute, so a single failure at night does not page). Find the cause in the API log: every unexpected error is one JSON line with `"event":"unhandled_error"` and `"source":"http_handler"` (error class, scrubbed message, top of the stack, no request data), next to the `request completed` lines with `status` 5xx. Typical causes: a dependency problem (check `ApiNotReady`), a bad deploy ([Bad deploy rollback](#bad-deploy-rollback)), a courier or SMTP outage surfacing as 502. The `route` label of `orderloop_http_requests_total` (Grafana, "API requests per second") says which endpoint.

#### Alert: ApiHighLatencyP95

The 95th percentile request duration was above 1.5 s for 10 minutes. Look at "Slowest routes" in the Grafana dashboard, `orderloop_db_ping_seconds` and the PostgreSQL connection count ([PostgresConnectionsHigh](#alert-postgresconnectionshigh)). Courier calls can take up to 60 s by design, so one slow external provider shows up here; check the `request completed` log lines for the route.

#### Alert: QueueOldestJobTooOld

The oldest waiting job in a queue (label `queue`) is over 5 minutes old: the worker is down, stuck, or slower than the arrival rate. Same steps as [Worker stuck or queue backlog](#worker-stuck-or-queue-backlog). `orderloop_queue_jobs{state="waiting"}` shows the depth; add a second worker process if it keeps growing. (`automation-tick` and `meta-health` are excluded: they are repeating schedules.)

#### Alert: AutomationJobsFailed

Jobs in `automation` (rule evaluations) or `automation-delivery` (one notification on one channel) used all 5 attempts and failed during the last 15 minutes. They stay in Redis for a week. The worker log has one `job failed` line per attempt with the reason; `GET /v1/automation/runs?status=failed` and `GET /v1/automation/deliveries?status=failed` show them per business, and `POST .../retry` is idempotent (see [monitoring.md](monitoring.md)). Frequent cause: a push or SMTP provider outage; the failures stop by themselves when it ends.

#### Alert: QueueFailedJobsHigh

More than 10 failed jobs are kept in `imports` or `meta-events`. Failed imports are already marked `FAILED` for the seller; look at the worker log for the shared cause (a code bug shows up as the same error on every job).

#### Alert: BackupStale

No successful backup was reported for 26 hours, or none was ever reported (`BackupNeverReported`, 3 hours after the API started seeing no value; Redis forgets the value when it is reset, and the backup loop re-reports the newest backup when it restarts). Run `docker compose logs --tail 50 backup`: `backup.failed` lines name the step (`preflight`, `snapshot`, `dump`, `upload`) and the reason; exit code 3 means the dump is fine but the off-site upload failed. Fix the cause, then take a backup now with `docker compose exec backup backup.sh`. Procedures: [backup-and-restore.md](backup-and-restore.md). **Until a backup succeeds you have no recent restore point; tell the pilot's owner.**

#### Alert: DiskSpaceLow

Under 15% free (warning) or 5% free (critical, `DiskSpaceCritical`) on a filesystem. PostgreSQL stops accepting writes when its disk is full. What grows: the PostgreSQL volume, the `backups` volume (`BACKUP_KEEP_DAILY`/`BACKUP_KEEP_WEEKLY`), Docker logs and images (`docker system df`). Never delete PostgreSQL files by hand ([Database down](#database-down), step 2); remove old images and logs, lower the backup retention, or grow the disk.

#### Alert: PostgresConnectionsHigh

More than 80% of `max_connections` are in use (the API pool is 10 per process, the worker 5, the backup, exporter and drill add a few). Look at `pg_stat_activity` (`docker compose exec postgres psql -U orderloop -c "select state, count(*) from pg_stat_activity group by 1"`): many `idle in transaction` means a stuck request. Restart the API if it is not releasing connections; raise `max_connections` only after checking memory.

#### Alert: MetricsLabelCapReached

A metric refused new label combinations (`orderloop_metrics_dropped_series_total{metric=...}`): a label is taking too many values. It is a bug, not an incident: nothing is lost except the extra series. Report it with the metric name; route templates, status classes and queue names are the only label values the code uses, never ids or emails.

#### Log alert: unhandled errors

Every unhandled error in the API and the worker is one JSON line on stderr with a stable `"event":"unhandled_error"` (plus `service`, `source`, `errorName`, a scrubbed `message` and the top of the stack; never request bodies, emails or ids). `source` is `http_handler` (a request failed with 500), `uncaughtException`, `unhandledRejection` or `startup` (the process exits and the supervisor restarts it). Alert on it in whatever collects the container logs, for example `docker compose logs --since 10m api worker | grep -c '"event":"unhandled_error"'`, or in Loki/Cloud Logging with the filter `event="unhandled_error"`. No error-tracking service is integrated; see [monitoring.md](monitoring.md#error-tracking).

## 5. Communication templates

Fill in the placeholders; keep facts only, no speculation, no blame, no promises you cannot keep. Send from the communications owner only.

**Initial notice (SEV1/SEV2)**

> Subject: OrderLoop incident, <short description>
>
> At <time UTC / local> we became aware that <what users see>. It started at about <time>. It affects <who / all businesses>.
> What you should do now: <e.g. do not book couriers from OrderLoop; book in the courier panel; do not re-enter the order>.
> We are working on it and will update you by <time>. Contact: <name, channel>.

**Update**

> Update <n> at <time>: <what we know now>. <What changed since the last update>. Next update by <time>.

**Resolved**

> The incident is resolved as of <time>. Cause: <one or two plain sentences>. Impact: <who, what, how long>. Data: <lost / not lost / what to re-check>.
> What we are changing: <actions>. A written review will follow by <date>.

**Data incident notice (after review with the data/privacy owner and counsel)**

> On <date> we found that <what happened> between <times>. The information involved: <categories>. It involved <number> businesses / <you>.
> What we have done: <contained, rotated credentials, ...>. What you can do: <actions>. How to reach us: <contact>.
> (Legal wording and any regulatory notice are decided by counsel; this template makes no compliance claim.)

**Courier-specific**

> Our records for <order numbers / time window> may not match <courier>. Please check the parcels in the <courier> panel for the references <OL-...>. Do not rebook until you have confirmed in their panel; we will help you settle each one.

## 6. Post-incident review template

Blameless; complete within five working days of resolution for SEV1/SEV2.

```
Title / ID:                      Severity:                 Date, duration (UTC):
Commander / participants:
Summary (3 sentences):
Impact: businesses affected, orders/stock/money affected, data exposed (Y/N), data lost (Y/N, how much / RPO)
Detection: how we noticed, how long after it started; which alert should have fired
Timeline (UTC): time | event | who
Root cause(s) and contributing factors:
What went well:                  What went badly:               Where we got lucky:
Resolution and verification: how we know it is fixed
Communication: what was sent, when, to whom; anything missing
Data/privacy decision (if any): who decided, outcome
Action items: | action | owner | due | priority (S/M/L) | tracked in
Docs to update: runbooks, monitoring, known limitations
```
