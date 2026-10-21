# Monitoring and logging

What the system exposes today, what it does not, and a minimum alert set for a controlled pilot. Everything under "What exists"
was read from the code; everything under "Proposed" is a suggestion that has **not been implemented or tested**.

## What exists today

### Health endpoints (API)

| Endpoint            | Auth | Behaviour                                                                                                                                                                                                                                                                                                           |
| ------------------- | ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /health/live`  | none | `200 {"status":"ok"}` whenever the process answers. No dependency checked. Use for process restarts.                                                                                                                                                                                                                |
| `GET /health/ready` | none | Opens a fresh connection to PostgreSQL (`SELECT 1`, as `app_user`) and to Redis (`PING`), each with a 1.5 s timeout. `200 {"status":"ok","checks":{"postgres":"up","redis":"up"}}`, or **`503`** with `"status":"degraded"` and the failing check `down`. Use for load-balancer readiness and the "is it up" alert. |

Not covered by readiness: **the worker** (it has no HTTP port and no health endpoint), queue depth or age, migrations, SMTP, courier or Meta reachability, disk. `health` lines are logged at `debug`, so they are invisible at the default `LOG_LEVEL=info`.
The web app has no health endpoint of its own; probe `GET /` or `/login` (expect 200) from outside. The API's `/health/ready` is the only dependency check.

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

There is no shared schema between API and worker logs (the worker has no `service` field). Tag them at the log shipper (by container or unit name).

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

Queue names: `imports`, `automation-tick`, `automation`, `automation-delivery`, `meta-events`, `meta-health`. BullMQ keeps keys `bull:<queue>:wait|active|delayed|failed|completed`. Retention:
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

## What does not exist

- **No metrics endpoint** (no `/metrics`, no Prometheus/StatsD/OpenTelemetry instrumentation).
- **No tracing** and no request-id propagation to the worker or to outbound courier/Meta calls.
- **No error tracker** (no Sentry or similar) in API, worker, web or mobile.
- **No alerting, dashboards, uptime checks or on-call tooling** in the repository.
- **No worker health endpoint**, but a Redis heartbeat: each worker process writes the current time to the key `worker:heartbeat` every 30 s (expires after 90 s). Check with `redis-cli -u "$REDIS_URL" GET worker:heartbeat` (an ISO time less than a minute old = a worker is alive; empty = no worker beats, or Redis is unreachable). It proves the process and its Redis connection, not that jobs are flowing; the `automation.tick` log line every minute remains the closest signal for that.
- **No queue-depth or age export**, no failed-job notification.
- **No operator/admin console** and no cross-tenant reporting.
- **No log shipping or retention configuration**; logs go to stdout and whatever your platform does with it.
- No browser or mobile crash reporting; no analytics events (the dashboard figures are computed from the database on request).

## Proposed minimum alerts for the pilot (not implemented)

Build these with whatever the host offers (a log/metrics service, or a small cron script using `curl` and `psql`). Thresholds are starting points.

| #   | Alert                                   | Signal / query                                                                                                                                                                                                                                                                                                                                                                                           | Proposed threshold                                    | Page?                |
| --- | --------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------- | -------------------- |
| 1   | API down or not ready                   | External probe of `https://<api>/health/ready` every minute (and `/health/live`). Body shows which of `postgres`/`redis` is `down`.                                                                                                                                                                                                                                                                      | 2 consecutive failures                                | yes                  |
| 2   | API 5xx rate                            | Log filter: `service="orderloop-api" msg="request completed" status>=500`; or load balancer 5xx.                                                                                                                                                                                                                                                                                                         | > 2% of requests over 5 min, or any 5xx burst >= 10   | yes                  |
| 3   | API latency                             | p95 of `durationMs` on `request completed`                                                                                                                                                                                                                                                                                                                                                               | > 2 s over 10 min                                     | no                   |
| 4   | Worker not running                      | No log line with `event="automation.tick"` for 3 minutes (it is logged every 60 s while the worker is healthy and Redis and PostgreSQL work), or the process supervisor reports the unit down.                                                                                                                                                                                                           | 3 min                                                 | yes                  |
| 5   | Queue backlog / age                     | `LLEN bull:automation-delivery:wait`, `LLEN bull:automation:wait`, `LLEN bull:meta-events:wait`, `LLEN bull:imports:wait`; and in PostgreSQL: `SELECT count(*), min(created_at) FROM import_jobs WHERE status = 'PENDING'` and `SELECT count(*), min(created_at) FROM social_events WHERE status = 'received'`. (Run as the admin/backup role: forced RLS hides these from `app_user` without a tenant.) | wait > 100 for 10 min, or oldest pending > 5 min      | yes (oldest)         |
| 6   | Failed automation runs / deliveries     | Admin role: `SELECT status, count(*) FROM automation_runs WHERE created_at > now() - interval '1 hour' GROUP BY 1;` and the same for `notification_deliveries` (look at `failed`). Log filter: `event="automation.job_failed"` or `event="automation.run" outcome="failed"`. Check the exact column names against `packages/db/prisma/schema.prisma` before use.                                         | any `failed` run; > 5 failed deliveries/hour          | no                   |
| 7   | Webhook failures (Meta)                 | Log filter: `path="/v1/webhooks/meta" status=401` (bad signature, `warn`); `status>=500`; worker `event="meta.queue_failed"` / `meta.job_failed`. Also Meta's own "Webhooks Disabled" email.                                                                                                                                                                                                             | > 10 x 401/10 min; any 5xx                            | yes (sustained)      |
| 8   | Webhook failures (couriers)             | Log filter: `path` starting `/v1/webhooks/couriers/` and `status` 401 or >= 500.                                                                                                                                                                                                                                                                                                                         | > 20 x 401/10 min; any 5xx                            | no                   |
| 9   | Meta connection needs attention         | Admin role: `SELECT tenant_id, provider, status, last_error_code, last_checked_at FROM social_connections WHERE status IN ('needs_reconnect','permission_error')`; worker `event="meta.health_failed"`; audit action `integration.needs_attention`. (No in-app notification exists for this.)                                                                                                            | any row                                               | no (tell the seller) |
| 10  | Courier uncertain / failed bookings     | Admin role: `SELECT count(*) FROM shipments WHERE status = 'booking_uncertain'`; a shipment in `booking_uncertain` blocks the order until a person settles it.                                                                                                                                                                                                                                           | any older than 30 min                                 | yes (pilot ops)      |
| 11  | Database disk, connections, replication | Host/provider metrics: free disk, `SELECT count(*) FROM pg_stat_activity`, vs `max_connections`. The API pool and worker pool (`max: 5`) need headroom.                                                                                                                                                                                                                                                  | disk < 20% free; connections > 80% of max             | yes (disk)           |
| 12  | Backup age                              | Newest successful backup timestamp (job output, object-store listing, or the provider's PITR "latest restorable time").                                                                                                                                                                                                                                                                                  | > 26 h for nightly; WAL lag > 15 min                  | yes                  |
| 13  | Redis down / memory                     | `/health/ready` shows `redis: down`; `redis-cli INFO memory` (`used_memory` vs `maxmemory`), evictions must be 0.                                                                                                                                                                                                                                                                                        | any                                                   | yes                  |
| 14  | Certificate and domain expiry           | External check of TLS expiry for the API and web hosts.                                                                                                                                                                                                                                                                                                                                                  | < 14 days                                             | no                   |
| 15  | Auth abuse                              | Log filter: `path="/v1/auth/login" status=429`, audit `auth.login_failed` and `auth.token_reuse_detected` counts.                                                                                                                                                                                                                                                                                        | spike vs baseline; any `token_reuse_detected` cluster | no                   |
| 16  | SMTP failures                           | Provider errors are logged by the API mailer (recipient hashed, addresses masked); watch `level="error"` lines from the mailer and automation email deliveries with `status = 'failed'` (`transient:` / `permanent:`). The exact log wording was not checked.                                                                                                                                            | any sustained                                         | no                   |

Admin-role queries need a role that can see all tenants (superuser or `BYPASSRLS`; **not** `app_user`) and should use a read-only role created for monitoring (not created by `pnpm db:setup`; not tested). Never run monitoring queries as `app_migrator` for long-lived connections.

A synthetic check is worth having: sign in as a dedicated pilot test account in a dedicated test business and read `GET /v1/me` every 5 minutes. It exercises PostgreSQL, Redis (lockout), password hashing and the JWT key.

## Log retention and personal data rules

- **Retention proposal**: 30 days online (searchable), 90 days archived for incident review; shorten if your privacy statement says so. Audit rows live in the database, not in logs.
- **What logs may contain**: request metadata, user and business ids, IP addresses (personal data in some jurisdictions), job ids, counts, error codes, scrubbed error text. They are designed to contain **no** passwords, tokens, message bodies, addresses, phone numbers or email addresses (the logging tests assert this for the auth flows and the automation privacy scan covers notifications).
- **Do not raise the level to debug in production for long.** `debug` logs health probes and may include more driver detail. `LOG_LEVEL=trace` should never be used in production.
- **Never** add request or response bodies to logs when debugging; reproduce locally with fictional data instead.
- **`MAIL_PROVIDER=console` is refused in production** because it prints one-time links. `PUSH_PROVIDER=dev` logs a redacted push line and, if `PUSH_DEV_OUTBOX` is set, writes what it would have sent to a file; do not set that variable in production.
- Restrict log access to named staff, and treat any log export or screenshot given to a seller or vendor as a disclosure.
- The plain-text `[worker]` lines can include library error messages that were **not** passed through the API's scrubber (`describe(err)` prints `err.message`). Review them before sharing outside the team; do not assume they are redacted.
- Deletion requests: logs are not tenant-partitioned and are not purged per business; state your retention window in the deletion response ([incident-response.md](incident-response.md#data-deletion-request)).
