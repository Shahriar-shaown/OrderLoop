# Monitoring and logging

What the system exposes, how to run the monitoring stack, which alerts exist and what they cover, and what is still missing.
Everything marked "tested locally" was run on a developer laptop on 2026-10-21 (Docker Desktop, Prometheus 3.15.1,
Alertmanager 0.34.1, Grafana 13.0.2); nothing here has run against real traffic, a real pager or a production host.

> **Status.** Metrics endpoints, a worker health server, Prometheus alert rules (with unit tests), an Alertmanager configuration,
> a Grafana dashboard and a compose profile to run them now exist (blocker B3). **Not done:** alert delivery to a real receiver
> (the webhook address is a placeholder), thresholds tuned on real traffic, log-based alerts (they need whatever collects your
> logs), an error-tracking service, and an on-call rota. See [what is not covered](#what-is-not-covered).

## Run the monitoring stack

The `monitoring` profile of [`deploy/docker-compose.yml`](../../deploy/docker-compose.yml) adds Prometheus, Alertmanager, Grafana,
a node exporter (disk, CPU) and a PostgreSQL exporter. Their ports are bound to `127.0.0.1` only: reach them through an SSH tunnel,
never publish them. They need `METRICS_TOKEN`, `GRAFANA_ADMIN_PASSWORD` and `ALERT_WEBHOOK_URL` in `deploy/.env`
(`deploy/generate-secrets.sh` generates the first two; the webhook address you must provide).

```bash
docker compose -f deploy/docker-compose.yml --profile monitoring up -d
# Prometheus  http://127.0.0.1:9090   (Status > Targets: api, worker, node, postgres, prometheus, alertmanager must be UP)
# Alertmanager http://127.0.0.1:9093
# Grafana     http://127.0.0.1:3001   (user admin, the password from deploy/.env; dashboard "OrderLoop overview" is provisioned)

# Validate the rules and run their unit tests (no stack needed):
docker run --rm --entrypoint promtool -v "$PWD/ops/monitoring":/m:ro prom/prometheus:v3.15.1 check rules /m/alerts.yml
docker run --rm --entrypoint promtool -v "$PWD/ops/monitoring":/m:ro prom/prometheus:v3.15.1 test rules /m/tests/alerts.test.yml
```

Files: [`ops/monitoring/prometheus.yml`](../../ops/monitoring/prometheus.yml), [`alerts.yml`](../../ops/monitoring/alerts.yml),
[`alertmanager.yml`](../../ops/monitoring/alertmanager.yml), [`tests/alerts.test.yml`](../../ops/monitoring/tests/alerts.test.yml),
[`grafana/`](../../ops/monitoring/grafana) (datasource, dashboard provider, `dashboards/orderloop.json`).

**What was run on 2026-10-21 (local):** `promtool check rules` (16 rules), `promtool test rules` (12 cases, all passed),
`amtool check-config`, the stack started under a throwaway project name, all 6 scrape targets `UP`, the 16 rules loaded and healthy,
the Grafana dashboard provisioned, and a live alert: the worker container was stopped and `WorkerHeartbeatStale` was watched
going from inactive to firing in Prometheus and arriving in Alertmanager (output in [Alert test](#alert-test-performed-on-2026-10-21-local)).
**Not run:** delivery of an alert to a webhook or email receiver, a browser look at the Grafana dashboard (it is provisioned and
found by the Grafana API, its panels were not inspected), the node exporter on a Linux host (the laptop run reports the Docker VM's disk).

## What exists today

### Health endpoints (API)

| Endpoint            | Auth | Behaviour                                                                                                                                                                                                                                                                                                           |
| ------------------- | ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /health/live`  | none | `200 {"status":"ok"}` whenever the process answers. No dependency checked. Use for process restarts.                                                                                                                                                                                                                |
| `GET /health/ready` | none | Opens a fresh connection to PostgreSQL (`SELECT 1`, as `app_user`) and to Redis (`PING`), each with a 1.5 s timeout. `200 {"status":"ok","checks":{"postgres":"up","redis":"up"}}`, or **`503`** with `"status":"degraded"` and the failing check `down`. Use for load-balancer readiness and the "is it up" alert. |

Not covered by readiness: queue depth or age, migrations, SMTP, courier or Meta reachability, disk. (Queue depth and age are exported as metrics; the others are not monitored.) `health` lines are logged at `debug`, so they are invisible at the default `LOG_LEVEL=info`.
The web app has no health endpoint of its own; probe `GET /` or `/login` (expect 200) from outside. The API's `/health/ready` is the only dependency check.

### Health endpoints (worker)

The worker runs a small HTTP server on `WORKER_HEALTH_PORT` (default 4010, all interfaces of its container; never publish it):

| Endpoint            | Auth                   | Behaviour                                                                                                                                                                                                                                                               |
| ------------------- | ---------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /health/live`  | none                   | `200 {"status":"ok"}` while the process answers.                                                                                                                                                                                                                        |
| `GET /health/ready` | none                   | `200` only if Redis answers `PING`, PostgreSQL answers `SELECT 1` (each within 1.5 s) **and** this process's heartbeat loop has written to Redis within the last 90 s; otherwise `503` with `{"status":"degraded","checks":{"redis":..,"postgres":..,"heartbeat":..}}`. |
| `GET /metrics`      | bearer `METRICS_TOKEN` | Prometheus text format (below). `404` while `METRICS_TOKEN` is unset, `401` without the right token.                                                                                                                                                                    |

The compose healthcheck of the worker uses `/health/ready`. The heartbeat key `worker:heartbeat` in Redis (written every 30 s, expires after 90 s) is still the
signal the API reads for `orderloop_worker_heartbeat_age_seconds`; check it by hand with `redis-cli -u "$REDIS_URL" GET worker:heartbeat`.

### Metrics (`/metrics`)

Prometheus text format, hand-written registry (`packages/observability`; the usual client library is deprecated). **Off unless
`METRICS_TOKEN` is set** (16+ characters): `GET /metrics` then needs `Authorization: Bearer <token>` (compared in constant time; a
token in the URL is never accepted). Without a token the endpoint answers `404` on both the API and the worker. In the compose
deployment the public proxy answers `404` for `/metrics` regardless: Prometheus scrapes `api:4000` and `worker:4010` over the internal network.

| Metric                                                                                     | Where  | Labels                             | Meaning                                                                                                                                                                                                                                                                                                                           |
| ------------------------------------------------------------------------------------------ | ------ | ---------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `orderloop_http_requests_total`                                                            | API    | `method`, `route`, `status_class`  | Requests by method, **route template** (`/v1/orders/:id`, or `unmatched`) and `2xx`..`5xx`. No ids, no query strings.                                                                                                                                                                                                             |
| `orderloop_http_request_duration_seconds` (histogram), `orderloop_http_requests_in_flight` | API    | same / none                        | Latency buckets 5 ms to 10 s.                                                                                                                                                                                                                                                                                                     |
| `orderloop_dependency_up`                                                                  | API    | `dependency` (`postgres`, `redis`) | The readiness probe's result (cached 2 s).                                                                                                                                                                                                                                                                                        |
| `orderloop_db_ping_seconds`                                                                | API    | none                               | `SELECT 1` through the API's connection pool (grows when the pool is exhausted); absent when it fails.                                                                                                                                                                                                                            |
| `orderloop_queue_jobs`                                                                     | API    | `queue`, `state`                   | Jobs per BullMQ queue (`imports`, `automation-tick`, `automation`, `automation-delivery`, `meta-events`, `meta-health`, `tenant-purge`) and state (`waiting`, `active`, `delayed`, `failed`, `paused`). `failed` on `automation` and `automation-delivery` counts runs and deliveries that used all their attempts (kept 7 days). |
| `orderloop_queue_oldest_waiting_age_seconds`                                               | API    | `queue`                            | Age of the oldest waiting job; 0 when none waits.                                                                                                                                                                                                                                                                                 |
| `orderloop_worker_heartbeat_age_seconds`, `orderloop_worker_heartbeat_present`             | API    | none                               | From the Redis heartbeat key. `present` is 0 once the key expired (no worker alive); absent when Redis is unreachable.                                                                                                                                                                                                            |
| `orderloop_backup_last_success_timestamp_seconds`                                          | API    | none                               | When `ops/backup.sh` last reported a success (through Redis); absent if never reported.                                                                                                                                                                                                                                           |
| `orderloop_worker_jobs_total`, `orderloop_worker_job_duration_seconds`                     | worker | `queue`, `result` / `queue`        | Job attempts finished by that worker process.                                                                                                                                                                                                                                                                                     |
| `orderloop_worker_own_heartbeat_age_seconds`, `orderloop_worker_ready`                     | worker | none / `check`                     | This process's own heartbeat age and readiness checks.                                                                                                                                                                                                                                                                            |
| `orderloop_metrics_dropped_series_total`                                                   | both   | `metric`                           | Label combinations refused because a metric hit its cap of 200 (600 for the HTTP metrics). Should stay 0.                                                                                                                                                                                                                         |
| `process_*`, `nodejs_*`, `orderloop_build_info`                                            | both   | few                                | CPU, resident memory, open file descriptors, heap, event loop lag; service and Node version.                                                                                                                                                                                                                                      |

Cardinality and privacy are enforced in code, not by convention: label values come from fixed sets (route templates, status
classes, queue names, dependency names), are truncated to 80 characters, and a metric accepts at most a fixed number of label
combinations (the rest are dropped and counted). Unit tests assert that no id, email, token or query string ever appears in a
label or in the output, and that a scan of 3,000 random paths produces at most one series. **Not exposed:** PostgreSQL pool
internals (Prisma's adapter owns the pool; connection pressure is visible through `orderloop_db_ping_seconds` and the PostgreSQL
exporter's `pg_stat_activity_count`), per-business figures, SMTP/courier/Meta reachability.

### API logs

One JSON object per line on stdout (pino), `service: "orderloop-api"`, ISO `time`, `level`. Per request, one `request completed` line:

| Field                  | Meaning                                                                                                                                                       |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `requestId`            | From the client's `x-request-id` if it matches `^[A-Za-z0-9._-]{8,64}$`, else a UUID. Returned in the `x-request-id` response header, so a user can quote it. |
| `method`, `path`       | Path without the query string.                                                                                                                                |
| `status`, `durationMs` | HTTP status and latency.                                                                                                                                      |
| `ip`                   | Real client address only if `TRUST_PROXY` equals the real hop count.                                                                                          |
| `userId`, `tenantId`   | When authenticated.                                                                                                                                           |

Level is `info` for 2xx/3xx, `warn` for 4xx, `error` for 5xx. Unhandled exceptions also log the scrubbed stack at `error` (the response body is a generic
`internal_error` problem). Bodies, headers, cookies, user agents and query strings are never logged; credential-named fields are `[REDACTED]`; free text goes
through a scrubber (JWTs, argon2 hashes, bearer tokens, connection URLs). Tested by `apps/api/test/logging.e2e.test.ts`. **Request logs do not include the request id on the
exception stack line**: correlate by time, `path` and `userId` when the 500 stack is separate from its request line.

Errors are RFC 9457 problem JSON with a stable `code` (list in [../api.md](../api.md#errors)); the response does not contain the request id (use the header).

### Worker logs

The worker (`apps/worker`, `node dist/main.js`) writes to stdout/stderr **in two formats**:

- plain text lines prefixed `[worker]` for start-up, shutdown, import processing, sweeps and errors (for example `[worker] job 123 failed: ...`, `[worker] sweep failed: ...`, `[worker] redis error: ...`, `[worker] ready, listening on queue "imports"`);
- **JSON lines** from the automation and Meta code (`time`, `level`, `event`, plus ids and counts; warnings and errors go to stderr): `automation.tick` (every minute: `rules`, `queued`, `requeuedDeliveries`), `automation.run`, `automation.delivery`, `automation.job_failed`, `automation.tick_rule_failed`, `push.receipts`, `meta.event_processed`, `meta.queue_failed`, `meta.swept`, `meta.purged`, `meta.health_checked`, `meta.health_failed`, `meta.health_unreachable`, `meta.job_failed`.
  Lines carry `tenantId`, `ruleId`, `runId`, `deliveryId`, `jobId`, `attempt`, `durationMs`, `outcome`; never message bodies, addresses, phone numbers or tokens.

The JSON `unhandled_error` line (below) carries `service: "orderloop-worker"`; the other worker lines have no `service` field. Tag them at the log shipper (by container or unit name).

### Error tracking

No error-tracking service is integrated and none is needed to be told about crashes. Every **unhandled** error in the API and the worker is written as one
JSON line to stderr with a stable field:

```json
{
  "time": "2026-10-21T15:38:21.1Z",
  "level": "error",
  "service": "orderloop-api",
  "event": "unhandled_error",
  "source": "http_handler",
  "errorName": "TypeError",
  "message": "...",
  "stack": "..."
}
```

`source` is `http_handler` (a request failed with a 500; the client got a generic `internal_error`), `uncaughtException`, `unhandledRejection` (both then exit with code 1 so the
supervisor restarts the process) or `startup` (invalid environment or a failed connection). The `message` and the first 8 stack lines are passed through the secret
scrubber (JWTs, bearer tokens, connection URLs, password-like values) and cut to 300 characters; **no request body, header, user id, email or business id is added**.
(The scrubber is pattern based; an error message that quotes free text could still carry something a person typed. It is not a guarantee.)

To alert on it, match `"event":"unhandled_error"` in whatever collects the container logs: a Loki/Cloud Logging/Datadog filter on `event = "unhandled_error"`,
or on a single host `docker compose logs --since 10m api worker | grep -c '"event":"unhandled_error"'` from cron. The runbook is
[incident-response.md](incident-response.md#log-alert-unhandled-errors). **Sentry (or a similar service) is an optional extension, not part of the code:** if you
want grouped errors and releases, add the vendor's Node SDK to `apps/api/src/main.ts` and `apps/worker/src/main.ts`, scrub events with the same rules (no bodies, no
emails), check its data-processing terms, and keep the log line as well. Nothing in the repository depends on it.

### Where failures are visible (per business, through the API)

| What                           | Where                                                                                                                                                                      | Who                                                                  |
| ------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| Failed automation runs         | `GET /v1/automation/runs?status=failed`; retry `POST /v1/automation/runs/:id/retry`                                                                                        | `automation:read` / `automation:manage` (a business's own data only) |
| Failed notification deliveries | `GET /v1/automation/deliveries?status=failed` (`attempts`, `lastError`: `permanent:` or `transient:`); retry `POST .../deliveries/:id/retry`                               | same                                                                 |
| Meta connection state          | `GET /v1/integrations/meta`: connection `status` (`active`, `needs_reconnect`, `permission_error`, `disconnected`), last check, error code                                 | `integrations:manage`                                                |
| Courier shipment problems      | Shipment statuses `booking_uncertain`, `booking_failed`, `delivery_failed`; the shipment's events show the courier's own words and "not applied" reasons                   | `couriers:read`                                                      |
| Failed imports                 | `GET /v1/imports` (`status`, first 100 row errors)                                                                                                                         | `catalog:write`                                                      |
| Audit trail                    | `GET /v1/audit-logs` (cursor-paginated; ids and actions, no secrets or message text; `auth.login_failed`, `auth.token_reuse_detected`, `integration.needs_attention`, ...) | `audit:read` (OWNER, ADMIN); one business at a time                  |

**There is no operator-level (cross-business) view.** To count failures across all businesses an operator must query PostgreSQL as a role that bypasses RLS (the backup/admin role) or iterate businesses through the API. See the queries below.

### Queues (Redis, BullMQ)

Queue names: `imports`, `automation-tick`, `automation`, `automation-delivery`, `meta-events`, `meta-health`, `tenant-purge` (their depth, age and failed counts are in `/metrics`: `orderloop_queue_jobs`). BullMQ keeps keys `bull:<queue>:wait|active|delayed|failed|completed`. Retention:
automation jobs 5 attempts (10, 20, 40, 80 s back-off), completed kept 1 day, **failed kept 7 days**; import jobs 3 attempts, completed kept 1 hour, **failed kept 24 h**. There is no
admin UI in the repository; any BullMQ dashboard or `redis-cli` works:

```bash
redis-cli -u "$REDIS_URL" --scan --pattern 'bull:*:failed'            # which queues have failed sets
redis-cli -u "$REDIS_URL" ZCARD bull:automation-delivery:failed        # failed count (sorted set)
redis-cli -u "$REDIS_URL" LLEN  bull:automation:wait                   # waiting jobs (a list)
redis-cli -u "$REDIS_URL" ZCARD bull:automation:delayed                # delayed (back-off, scheduled)
redis-cli -u "$REDIS_URL" ZCARD bull:meta-events:failed
```

(Key names follow BullMQ's default layout; check them with `--scan` on your version before building alerts on them.)

### Audit logs

Append-only table `audit_logs` (the application role cannot update or delete). Actions are listed in [../permissions.md](../permissions.md#audit-trail). Useful for incident reconstruction; **not** a security event stream (no export, no alerting).

## Alerts

All rules are in [`ops/monitoring/alerts.yml`](../../ops/monitoring/alerts.yml), each with a runbook link to
[incident-response.md](incident-response.md#alert-runbooks). Thresholds are starting points for a pilot with little traffic; **re-tune them after a week of real data.**

| Alert                                 | Fires when                                                                                                                   | For          | Severity           |
| ------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- | ------------ | ------------------ |
| `ApiDown`                             | the API target cannot be scraped (process down, wrong `METRICS_TOKEN`, or `/metrics` disabled)                               | 2 min        | critical           |
| `ApiNotReady`                         | `orderloop_dependency_up == 0` (PostgreSQL or Redis unreachable from the API)                                                | 2 min        | critical           |
| `WorkerDown`                          | the worker's health server cannot be scraped                                                                                 | 2 min        | critical           |
| `WorkerHeartbeatStale`                | heartbeat key expired (`present == 0`) or older than 120 s                                                                   | 2 min        | critical           |
| `ApiHigh5xxRate`                      | more than 5% of requests answer 5xx over 5 min, with at least 0.05 requests/s                                                | 5 min        | critical           |
| `ApiHighLatencyP95`                   | p95 request duration above 1.5 s                                                                                             | 10 min       | warning            |
| `ApiDatabaseSlow`                     | `SELECT 1` through the pool above 0.5 s                                                                                      | 5 min        | warning            |
| `QueueOldestJobTooOld`                | oldest waiting job above 5 min (`automation-tick` and `meta-health` excluded: repeating schedules)                           | 5 min        | warning            |
| `AutomationJobsFailed`                | the failed count of `automation` or `automation-delivery` grew in the last 15 min (runs / deliveries that used all attempts) | none         | warning            |
| `QueueFailedJobsHigh`                 | more than 10 failed jobs in `imports` or `meta-events`                                                                       | 10 min       | warning            |
| `BackupStale` / `BackupNeverReported` | last reported backup older than 26 h / none reported for 3 h                                                                 | 10 min / 3 h | critical / warning |
| `DiskSpaceLow` / `DiskSpaceCritical`  | under 15% / 5% free on a filesystem (node exporter)                                                                          | 10 / 5 min   | warning / critical |
| `PostgresConnectionsHigh`             | connections above 80% of `max_connections` (PostgreSQL exporter)                                                             | 5 min        | warning            |
| `MetricsLabelCapReached`              | a metric refused new label combinations (a bug, not an incident)                                                             | none         | warning            |

Alertmanager groups them and posts to **one webhook** read from `ALERT_WEBHOOK_URL` (a Compose secret file); an email receiver is a commented example. While
`ApiDown` fires, the alerts derived from API metrics are inhibited. `promtool test rules` covers 12 scenarios: worker stopped, stale heartbeat, healthy worker (no
alert), API unreachable and readiness, 5xx above and (at very low traffic) below the threshold, p95 latency, queue age, failed automation jobs, failed import jobs, stale backup,
backup never reported, low disk, high connection count.

### Alert test (performed on 2026-10-21, local)

From `./deploy/smoke-test.sh --only monitoring` (throwaway project, laptop; this is the real output with container-start lines removed):

```
$ docker compose --profile monitoring up -d        # prometheus, alertmanager, grafana, node-exporter, postgres-exporter
   ok: Prometheus is ready
   ok: all 6 scrape targets are up
     alertmanager  up  http://alertmanager:9093/metrics
     api           up  http://api:4000/metrics
     node          up  http://node-exporter:9100/metrics
     postgres      up  http://postgres-exporter:9187/metrics
     prometheus    up  http://localhost:9090/metrics
     worker        up  http://worker:4010/metrics
== alert rules loaded: 16 rules, all health "ok" (ApiDown, ApiNotReady, WorkerDown, WorkerHeartbeatStale, ApiHigh5xxRate, ApiHighLatencyP95, ApiDatabaseSlow,
   QueueOldestJobTooOld, AutomationJobsFailed, QueueFailedJobsHigh, BackupStale, BackupNeverReported, DiskSpaceLow, DiskSpaceCritical, PostgresConnectionsHigh, MetricsLabelCapReached)
== Grafana: dashboard provisioned
     dashboard: OrderLoop overview (orderloop-overview)
== fire a test alert: stop the worker
     before: heartbeat_present = 1
$ docker compose stop worker
   ok: expression 'orderloop_worker_heartbeat_present == 0' evaluates true        (the heartbeat key expires 90 s after the last beat)
     Prometheus: WorkerDown firing severity=critical runbook=docs/operations/incident-response.md#alert-workerheartbeatstale
     Prometheus: WorkerHeartbeatStale firing severity=critical runbook=docs/operations/incident-response.md#alert-workerheartbeatstale
   ok: Alertmanager received WorkerHeartbeatStale
     Alertmanager: WorkerDown status=active receivers=default
     Alertmanager: WorkerHeartbeatStale status=active receivers=default
$ docker compose start worker   ->   ok: worker is healthy again
```

The alert took a few minutes from the stop to firing (about 90 s for the key to expire, then the rule's `for: 2m`; the exact time was not recorded). The receiver `default` is the placeholder
webhook, so **no notification left the laptop**. The rule unit tests (`promtool test rules`, 12 cases) passed:

```
$ promtool test rules ops/monitoring/tests/alerts.test.yml
  SUCCESS
```

## What is not covered

- **No log-based alerts are shipped** (no log collector exists in the stack): API 5xx per route beyond the ratio alert, webhook signature failures, auth abuse (`429` on `/v1/auth/login`,
  `auth.token_reuse_detected`), SMTP failures, courier `booking_uncertain` shipments, Meta connections needing attention, certificate expiry. The earlier proposal for
  these stays valid; each needs either a log filter (the `event: unhandled_error` line is the one stable field) or a read-only database role for monitoring queries
  (the `app_monitor` role created by the migrate job sees statistics only, **not** table data, and `app_backup` is not for monitoring).
- **No operator-level (cross-business) view** of failed automation runs or deliveries beyond the queue counts; per business, the API endpoints above show them.
- **No tracing**, no request-id propagation to the worker or to outbound courier/Meta calls, no browser or mobile crash reporting, no analytics.
- **No uptime check from outside the host.** Prometheus runs on the same host as the stack: if the host dies, nothing alerts. Add an external probe of `https://<api>/health/ready`
  (any uptime service) before relying on this.
- **Alerts reach a person only if you configure a receiver.** The default webhook is a placeholder that goes nowhere. Page routing, on-call and escalation are not set up.
- **Thresholds are untuned guesses**; metrics were only seen on a test stack with a handful of requests.
- Redis memory pressure (`INFO memory`, evictions) is not exported; the compose Redis has `maxmemory 192mb` with `noeviction`, so a full Redis refuses writes and the API's readiness
  eventually reports `degraded`.
- PostgreSQL replication, WAL archiving and PITR lag: none is configured.
- A synthetic check is still worth having: sign in as a dedicated pilot test account in a dedicated test business and read `GET /v1/me` every 5 minutes. It exercises PostgreSQL, Redis (lockout), password hashing and the JWT key.

## Log retention and personal data rules

- **Retention proposal**: 30 days online (searchable), 90 days archived for incident review; shorten if your privacy statement says so. Audit rows live in the database, not in logs.
- **What logs may contain**: request metadata, user and business ids, IP addresses (personal data in some jurisdictions), job ids, counts, error codes, scrubbed error text. They are designed to contain **no** passwords, tokens, message bodies, addresses, phone numbers or email addresses (the logging tests assert this for the auth flows and the automation privacy scan covers notifications).
- **Do not raise the level to debug in production for long.** `debug` logs health probes and may include more driver detail. `LOG_LEVEL=trace` should never be used in production.
- **Never** add request or response bodies to logs when debugging; reproduce locally with fictional data instead.
- **`MAIL_PROVIDER=console` is refused in production** because it prints one-time links. `PUSH_PROVIDER=dev` logs a redacted push line and, if `PUSH_DEV_OUTBOX` is set, writes what it would have sent to a file; do not set that variable in production.
- Restrict log access to named staff, and treat any log export or screenshot given to a seller or vendor as a disclosure.
- The plain-text `[worker]` lines can include library error messages that were **not** passed through the API's scrubber (`describe(err)` prints `err.message`). Review them before sharing outside the team; do not assume they are redacted.
- Deletion requests: logs are not tenant-partitioned and are not purged per business; state your retention window in the deletion response ([incident-response.md](incident-response.md#data-deletion-request)).
