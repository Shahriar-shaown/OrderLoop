# Automation and notifications

Rules that watch a business and tell the right people: low stock, new orders, orders nobody confirmed, orders running late,
cash-on-delivery discrepancies, and a daily and weekly report. Notifications appear in the app (in-app), can be pushed to
phones, emailed, and (only with a provider and the person's own consent) sent by SMS or WhatsApp. **Everything works with no
paid service**: Redis and Postgres you already run, Mailpit for email, a development push provider that records instead of
sending, and a console provider for SMS and WhatsApp that only logs.

- [Architecture](#architecture)
- [The seven kinds, exactly](#the-seven-kinds-exactly)
- [Who is told](#who-is-told)
- [Scheduling, slots and daylight saving](#scheduling-slots-and-daylight-saving)
- [Idempotency, retries and the at-least-once edge](#idempotency-retries-and-the-at-least-once-edge)
- [Privacy](#privacy)
- [Push, email, SMS and WhatsApp](#push-email-sms-and-whatsapp)
- [Environment variables](#environment-variables)
- [Running it locally](#running-it-locally)
- [Looking at failures, retrying, simulating failures](#looking-at-failures-retrying-simulating-failures)
- [Runbook](#runbook)
- [Known limits](#known-limits)
- [What proves it](#what-proves-it)

## Architecture

```
API (POST .../run, order created)                 worker (apps/worker)
   │  evaluate now / enqueue neworder:<id>          │  ONE job scheduler "automation-tick", every minute
   ▼                                                ▼
 queue "automation"  ◄──── tick: due rules ───── queue "automation-tick"
   │  deterministic job id <ruleId>__<slotKey>
   ▼
 evaluation (packages/automation)         one transaction: recipients → new subjects (claimed) → notifications + deliveries
   │  after commit: one job per (notification, channel), id delivery__<deliveryId>
   ▼
 queue "automation-delivery" ──► delivery worker ──► push (dev | expo) · email (SMTP/Mailpit) · sms · whatsapp (console)
```

- **One package, two callers.** `packages/automation` holds the engine (evaluation, claiming, delivery, the tick, the providers).
  The API runs it for `POST /v1/automation/rules/:kind/run` (same code, same de-duplication as the scheduler); the worker runs it
  from BullMQ. `apps/worker/src/automation.ts` is only wiring. Pure rules (who may receive what, `dueSlot`, the wording of every
  notification) live in `packages/domain/src/automation.ts` and are unit-tested exhaustively.
- **No in-process cron per business.** The worker registers one repeatable job with `upsertJobScheduler('automation-tick',
{ every: 60000 })`. The scheduler id makes registration idempotent, so any number of workers start up and there is still one
  tick a minute. The tick does not evaluate anything: it finds what is due and queues evaluations under deterministic ids.
- **The one cross-business read** the tick needs (which rules are on, with each business's time zone) is the `SECURITY DEFINER`
  function `enabled_automation_rules(after_id, max_rows)`; the re-queue of deliveries that were committed but never queued is
  `stale_pending_deliveries(seconds, max_rows)`. Same pattern as `stale_pending_imports` (see [database.md](database.md)): the
  function runs as the table owner, which has one owner-only `SELECT` policy; `app_user` stays fully confined.
- **Redis holds ids only.** Job payloads are `{tenantId, ruleId, slotKey...}`, `{tenantId, orderId}` or `{tenantId,
deliveryId}` (Expo receipt jobs also hold push tokens for fifteen minutes). Notification text, order data and customer data
  stay in Postgres. The worker validates every payload again.

### Tables

All are in migration `20261026100000_automation_notifications`. Tenant tables carry `tenant_id`, forced row-level security,
composite `(tenant_id, id)` foreign keys, and are listed in `TENANT_TABLES`; `push_devices` is global (a person's phone).

| Table                      | Purpose                                                                                                                                                                                                                              |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `automation_rules`         | One row per (business, kind), created when someone first saves it. `enabled`, `config` (validated per kind), `channels`, `enabled_at`. Unique `(tenant_id, kind)`.                                                                   |
| `automation_runs`          | One evaluation. **`UNIQUE (rule_id, slot_key)` is the idempotent scheduling slot.** `trigger` (`scheduled`, `event`, `manual`, `retry`), `status`, `attempts`, `error`, `created_count`, `skipped_count`, timestamps.                |
| `automation_state`         | Episode tracking, `(rule_id, subject_id)`: what a rule already announced (a variant, an order, a discrepancy) and how often. Removed when the subject stops matching, which re-arms the rule for it.                                 |
| `notifications`            | One per recipient: `kind`, `title`, `body`, `data` (ids and counts), `dedupe_key`, `in_app`, `read_at`. **`UNIQUE (tenant_id, user_id, dedupe_key)`**. Composite FK to the membership (a removed member's notifications go with it). |
| `notification_preferences` | `(tenant_id, user_id, kind)` → `in_app`, `push`, `email`. Defaults (no row): in-app on, push on, email off.                                                                                                                          |
| `notification_deliveries`  | One per (notification, channel): `status` (`pending`, `sent`, `failed`, `skipped`), `attempts`, `last_error`, `claimed_at` (a lease), `sent_at`. **`UNIQUE (notification_id, channel)`**. In-app deliveries are born `sent`.         |
| `push_devices`             | Global: `user_id`, `token` (unique), `platform` (`ios`/`android`), `provider` (`expo`/`dev`), `last_seen_at`. Registered once per phone and valid in every business the person belongs to.                                           |
| `messaging_consents`       | A member's own consent for `sms` or `whatsapp` with the number to use: `granted_at`, `revoked_at`, `source`. Unique per (business, member, channel). Never deleted: revoked.                                                         |

Row-level security on `push_devices` is enabled (not forced): a person reads and writes only their own rows; inside a
business's context the worker may also _read_ the devices of that business's members. Moving a token to another person (a phone
that changed hands) and dropping a dead token are two narrow `SECURITY DEFINER` functions (`upsert_push_device`, which refuses a
user other than the caller, and `remove_push_token`).

## The seven kinds, exactly

Every rule has `enabled` (off by default), a per-kind `config`, and `channels` `{inApp, push, email, sms, whatsapp}` (defaults
`true, true, false, false, false`). "Digest" means **one notification per recipient per run**, naming at most the top five ids
and counting the rest; a run never makes one notification per variant or order.

| Kind                | Trigger                                                               | Config (`PUT .../rules/:kind`)                                             | De-duplication                                                                                                                                                                                                                                        |
| ------------------- | --------------------------------------------------------------------- | -------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `LOW_STOCK`         | Scan, every 5 minutes (slot = 5-minute bucket)                        | `{ basis: 'reorder_point' \| 'fixed', fixedQuantity?, includeZeroStock }`  | A variant announced as low stays quiet until it is no longer low (its episode ends), then re-arms: the next dip is announced again.                                                                                                                   |
| `NEW_ORDER`         | **Event**: the API queues `neworder__<orderId>`; plus a catch-up scan | `{}`                                                                       | The order is claimed in `automation_state` by whichever of the event job and the catch-up gets there first. Orders created before the rule was switched on are never announced.                                                                       |
| `UNCONFIRMED_ORDER` | Scan, every 5 minutes                                                 | `{ afterMinutes: 5..10080, repeatEveryMinutes?: 5..10080 }`                | First reminder when an order has been `pending_confirmation` for `afterMinutes` (counted from creation). With `repeatEveryMinutes`, again that long after the last reminder, **at most 3 notifications per order**. Confirming or cancelling ends it. |
| `DELAYED_ORDER`     | Scan, every 5 minutes                                                 | `{ afterHours: 1..720 }`                                                   | Announced once per order. A change of phase restarts the clock and re-arms it.                                                                                                                                                                        |
| `COD_DISCREPANCY`   | Scan, every 5 minutes                                                 | `{ minAmountMinor? }`                                                      | Announced once per open discrepancy; resolving or waiving ends the episode (a reopened one is announced again).                                                                                                                                       |
| `DAILY_REPORT`      | Report slot: the business's local `HH:mm`                             | `{ localTime: 'HH:mm' }` (default `20:00`)                                 | One per local date: slot `daily:2026-03-29`; the notification's dedupe key is the slot.                                                                                                                                                               |
| `WEEKLY_REPORT`     | Report slot: local `HH:mm` on the chosen weekday                      | `{ localTime: 'HH:mm', weekday: 0..6 }` (0 = Sunday; default Sunday 09:00) | One per local ISO week: slot `weekly:2026-W13`.                                                                                                                                                                                                       |

Definitions in detail:

- **Low stock.** A variant is low when its _available_ stock (on hand minus reserved, summed over all locations) is at or below
  its threshold. `basis: reorder_point` uses each variant's own reorder point (a reorder point of 0 means that variant never alerts);
  `basis: fixed` uses `fixedQuantity` for every variant. A completely out-of-stock variant is included only with
  `includeZeroStock` (otherwise only "running low", above zero). Archived variants and variants of archived products never count.
- **Unconfirmed order.** Real status: `pending_confirmation`. The age is `now - orders.created_at`.
- **Delayed order.** Real statuses, from [orders.md](orders.md). The clock starts at the **last time the order entered
  `confirmed`** while its status is `confirmed` or `ready_to_ship` (not handed to a courier yet), or at the **last time it
  entered `shipped`** while its status is `shipped`, `in_transit` or `delivery_failed` (on its way, or came back). It is delayed
  when that clock is more than `afterHours` old. `delivered`, `cancelled`, `return_requested`, `returned` and
  `pending_confirmation` orders are never delayed (an unconfirmed one is the other rule's business). The times come from
  `order_status_history`; an order without history uses `created_at`.
- **COD discrepancy.** Rows of `discrepancies` with `status = open` (see [finance.md](finance.md)). With `minAmountMinor`, only
  those whose `|actual - expected|` is at least that many paisa (a discrepancy with no amounts always counts).
- **New order catch-up.** The five-minute scan announces orders created in the **last 30 minutes** (and after the rule was
  switched on) that nobody has announced. This covers an event that was never queued: failing to queue the event never fails the
  order. Orders created by CSV import are announced by this scan (the import does not queue events).
- **Reports.** Business-level totals only: orders created, revenue (sum of totals of orders created and not cancelled),
  delivered and cancelled (status changes in the window), items low on stock now, open COD discrepancies. Daily covers **today so
  far** (local midnight to now); weekly covers **the last 7 local days including today**. Windows are whole local days in the
  business's `tenants.timezone`.

## Who is told

Recipients are **the active members of that business** whose role holds the permission for the topic:

| Kind                                               | Needs            |
| -------------------------------------------------- | ---------------- |
| `LOW_STOCK`                                        | `inventory:read` |
| `NEW_ORDER`, `UNCONFIRMED_ORDER`, `DELAYED_ORDER`  | `orders:read`    |
| `COD_DISCREPANCY`, `DAILY_REPORT`, `WEEKLY_REPORT` | `finance:read`   |

(`packages/domain/src/automation.ts`, `RECIPIENT_PERMISSION`.) A disabled account is not a recipient. Per recipient the channels
are what the **rule** switches on, narrowed by the person's own preferences (`in_app`, `push`, `email`); `sms` and `whatsapp` need
the person's own recorded consent and a number. A person left with no channel is not a recipient. If nobody is, the run is
`skipped` **and nothing is claimed**, so someone who becomes a recipient later still hears about it.

Setting up the rules needs `automation:read` (owner, admin, manager) and `automation:manage` (owner, admin); see
[permissions.md](permissions.md). Notifications themselves are per person: any member lists and reads their own, sets their own
preferences, and registers or removes their own phones.

## Scheduling, slots and daylight saving

A **slot** is the unit of idempotency: `automation_runs` has `UNIQUE (rule_id, slot_key)`. A second execution of a slot (a
second worker, a duplicate queue message, a retry) is a no-op, or resumes the run if it failed.

- **Scan kinds:** the slot is the 5-minute bucket of the clock, `scan:20261025T1430Z` (14:30 to 14:35 UTC). The tick (every
  minute) queues `<ruleId>__scan_20261025T1430Z`; BullMQ ignores a second add under the same id.
- **New order events:** slot `neworder:<orderId>`, job id `neworder__<orderId>`.
- **Manual runs (`POST /v1/automation/rules/:kind/run`):** a scan rule gets a fresh slot (`manual:<key>`), so asking again
  evaluates again, but what was already announced stays announced (episode state), even when two runs race. Send an
  `idempotencyKey` and the same key returns the first run. A report rule uses the **natural slot of today / this week**, so
  running a report by hand _is_ that day's report and the scheduler does not send it again.
- **Report slots** come from the pure function `dueSlot(now, tz, rule)` in `packages/domain/src/automation.ts`, using
  `Intl` and the business's `tenants.timezone`. The slot is named by the **local date** (daily) or **local ISO week** (weekly),
  never by an instant:
  - **Clocks go back** (a local time happens twice): both give the same key, so the report fires once. Europe/London, 25 Oct 2026:
    a 01:30 report fires at the first 01:30 (00:30 UTC) and the repeat at 01:30 GMT is the same slot.
  - **Clocks go forward** (a local time never happens): the wall clock passes it at the first valid minute that day, and the
    report is due then. New York, 8 Mar 2026, 02:30: due at 03:00 EDT (07:00 UTC).
  - **Downtime:** a report whose time has passed is due as soon as the worker is back, but **only until local midnight**: a day
    that was missed entirely is not sent the next morning. Within the day it fires once.
  - **A business changes its time zone:** the key is the local date in the zone at that moment, so an instant already covered
    (same local date) stays covered and a new local date is a new day. The report time `HH:mm` itself can also be edited freely;
    editing it after the report went out does not send it again.
  - Weekday 0 is Sunday. Tests cover Asia/Dhaka (no daylight saving), Europe/London and America/New_York transitions with
    injected clocks (`packages/domain/src/automation.test.ts`, and the fake-clock tick test in the API suite).

## Idempotency, retries and the at-least-once edge

An evaluation is: **(a)** claim the run through its unique slot; **(b)** in one transaction, decide who is told, claim the
new subjects in `automation_state`, and insert notifications (`ON CONFLICT DO NOTHING` on the dedupe key) with their deliveries;
**(c)** after the commit, queue one delivery job per (notification, channel) under the id `delivery__<deliveryId>`.

- Because (b) is one transaction, a crash can never leave a subject marked as announced with nobody told, or a notification
  without its deliveries. Two evaluations racing over the same subject: the claim is an `INSERT ... ON CONFLICT DO NOTHING
RETURNING`, so only one gets it.
- A run that crashed while `running` is taken over only when the queue redelivers the job (`attemptsStarted > 1`: the previous
  attempt is over); another worker meeting a `running` run leaves it. A `failed` run resumes. If the process dies between the
  commit and the queueing, the run is resumed (its pending deliveries are queued; nothing new is created) or, for deliveries,
  the tick queues any that sat `pending` for over a minute (`stale_pending_deliveries`).
- **Delivery** claims its row with `UPDATE ... WHERE status IN ('pending','failed')` and a 5-minute lease (`claimed_at`), which a
  queue redelivery ignores. A delivery that is `sent` or `skipped`, or held by a live worker, is never sent again, whatever is
  queued. `(notification_id, channel)` is unique, so a retry can never create a second delivery.
- **Queue policy** (every automation job): 5 attempts, exponential back-off from 10 s (10, 20, 40, 80 s), completed jobs kept a
  day, failed jobs a week.
- **Permanent versus transient** (`classifyError`): a refused address (SMTP 5xx), an HTTP 4xx other than 408/429, or an explicit
  permanent error is recorded as `failed` with `permanent:<reason>` and **not retried**. A network error, timeout, SMTP 4xx, HTTP
  5xx/408/429 or anything unknown is recorded as `failed` with `transient:<reason>` and rethrown so the queue retries. Expected
  non-deliveries are `skipped` with a reason: `no_device`, `device_not_registered`, `no_consent`, `no_phone`,
  `channel_not_configured`, `recipient_disabled`, `recipient_gone`, `provider_mismatch`. A push token the push service reports as
  `DeviceNotRegistered` is **removed**.
- **The unavoidable edge (at-least-once).** If a worker dies after the provider accepted a message and before the delivery is
  marked `sent`, the queue's retry sends it again. Mitigations: email carries a stable `Message-ID`
  (`<deliveryId@orderloop.local>`) and messaging providers get a stable idempotency key (the delivery id), which a provider that
  supports it uses to drop the repeat; Expo push has no idempotency key, so a duplicate push is possible in that one window. A push
  to several of a person's phones is one delivery: if one phone fails transiently after another succeeded, the retry can push
  again to the one that already got it.

Visibility and manual retry: `GET /v1/automation/runs?status=&kind=` and `GET /v1/automation/deliveries?status=failed`
(`automation:read`); `POST /v1/automation/runs/:id/retry` and `POST /v1/automation/deliveries/:id/retry`
(`automation:manage`). Both retries are idempotent: only a `failed` item moves (to `queued` / `pending`) and one job is queued; a
second press, or retrying something that already succeeded or was sent, changes nothing.

Operational logging (worker and API): one JSON line per run, delivery and tick with `tenantId`, `ruleId`, `runId`,
`deliveryId`, `jobId`, `attempt`, `durationMs` and `outcome` (and the counts). Lines never contain a message body, an address,
a phone number or a token (push tokens appear as a 10-character fingerprint). The counts are also on the run row
(`created_count`, `skipped_count`).

Manual runs are rate limited to **10 per minute per business** (`429 rate_limited`).

## Privacy

A notification names only what the business owns: order numbers, SKUs, product names, counts, and business-level totals in
reports. It never contains a customer's name, phone, address or email, nor an amount tied to a person. The builders in
`packages/domain/src/automation.ts` only accept ids, numbers and names of products; a unit test feeds them hostile extra fields
(a customer's name, phone, email, address) and scans every title, body, `data` and push payload for them, and the API suite
repeats the scan on a real order, its notification, the pushed payload and the email.

- **Push payload:** a generic title and body (`Low stock alert` / `Open OrderLoop to see the details.`) and `data: { kind, id }`
  where `id` is the notification id. Apple, Google and Expo never see order numbers; the app fetches the notification after the
  person is signed in.
- **Email** uses the same title and body as the in-app notification (no customer data), plus "Open OrderLoop to see the
  details".
- `data` on a notification holds ids and counts only (`orderIds`, `variantIds`, `discrepancyIds`, `count`, report dates).
- A failed delivery stores a short error with addresses, tokens and numbers removed (`scrubError`).
- The audit trail records `automation.rule_changed` with **field names only** (`enabled`, `config`, `channels`), never values,
  and `messaging.consent_granted` / `messaging.consent_revoked` with the channel, never the number.

## Push, email, SMS and WhatsApp

| Channel  | Provider                                                 | Needs                                                                              |
| -------- | -------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| in-app   | none (the notification is the delivery)                  | nothing                                                                            |
| push     | `dev` (default) or `expo`, chosen by `PUSH_PROVIDER`     | a registered device (`POST /v1/push-devices`); `expo` needs a real Expo push token |
| email    | the existing mailer settings: Mailpit/SMTP, or `console` | `MAIL_PROVIDER` (the worker reads the same `MAIL_*`/`SMTP_*`)                      |
| sms      | `SMS_PROVIDER=console` (logs only) or `none`             | the provider **and** the recipient's consent with a number                         |
| whatsapp | `WHATSAPP_PROVIDER=console` (logs only) or `none`        | the provider **and** the recipient's consent with a number                         |

- **`DevPushProvider`** (default): logs one redacted line per push and records the delivery as `sent`; with `PUSH_DEV_OUTBOX=<file>`
  it also appends what it would have sent as one JSON line each (tokens as a fingerprint), so `tail -f` shows pushes arriving.
  Nothing reaches a phone. In production a loud warning is logged at start-up by the API and the worker.
- **`ExpoPushProvider`** (`PUSH_PROVIDER=expo`): HTTPS to `exp.host`, batches of 100, optional `EXPO_ACCESS_TOKEN`, 10 s timeout.
  A per-message `DeviceNotRegistered` removes the token; a rate limit is transient; other per-message errors are permanent. A
  delayed job (15 minutes later) fetches **receipts** and removes tokens reported dead there. Whole-request failures are
  classified by HTTP status.
- **SMS and WhatsApp** have an interface (`MessagingProvider`) and one implementation, `ConsoleMessagingProvider`, which logs the
  channel, a masked number and the message length. **No vendor is integrated.** `none` means the channel is unavailable:
  `PUT /v1/automation/rules/:kind` with `channels.sms` or `channels.whatsapp` is `422 channel_not_configured`, and so is granting
  a consent for it. `422 consent_required` is returned when nobody who would receive the rule has a recorded consent. At send
  time each recipient is checked again: a revoked consent is `skipped` (`no_consent`).
- **Consent** is per member and per business: `PUT /v1/messaging-consents` `{ channel, granted, phone }` for yourself only
  (a Bangladeshi mobile number in any usual spelling; stored as `+8801XXXXXXXXX`); revoking keeps the row.

## Environment variables

| Variable                               | Default  | Notes                                                                         |
| -------------------------------------- | -------- | ----------------------------------------------------------------------------- |
| `PUSH_PROVIDER`                        | `dev`    | `dev` or `expo`. `dev` in production logs a loud warning (not refused).       |
| `PUSH_DEV_OUTBOX`                      | unset    | Dev provider only: a file to append what it would have pushed, as JSON lines. |
| `EXPO_ACCESS_TOKEN`                    | unset    | Expo provider only, when the Expo project requires authenticated pushes.      |
| `SMS_PROVIDER`, `WHATSAPP_PROVIDER`    | `none`   | `none` (channel unavailable) or `console` (logs only).                        |
| `MAIL_PROVIDER`, `MAIL_FROM`, `SMTP_*` | existing | Used by the worker for notification email, exactly as by the API.             |
| `REDIS_URL`                            | existing | Queues `automation`, `automation-delivery` and `automation-tick`.             |

The API and the worker both read `PUSH_PROVIDER`, `SMS_PROVIDER` and `WHATSAPP_PROVIDER` (the API to refuse a channel that could
never send and to mark a registered phone with its provider; the worker to send). Give both the same values.

## Running it locally

```bash
pnpm services:up && pnpm services:mail          # Postgres, Redis, Mailpit (inbox at http://localhost:8025)
pnpm db:init && pnpm db:seed                    # roles, migrations, the demo business
# .env: MAIL_PROVIDER=smtp SMTP_HOST=127.0.0.1 SMTP_PORT=1025   (so the worker's emails land in Mailpit)
#       PUSH_DEV_OUTBOX=/tmp/orderloop-push.jsonl
pnpm --filter @orderloop/api dev                # terminal 1: the API
pnpm --filter @orderloop/worker dev             # terminal 2: the worker (tick, evaluation and delivery)
tail -f /tmp/orderloop-push.jsonl               # terminal 3: pushes as they would be sent
```

**See it end to end in one command** (no worker needed; it delivers in-process):

```bash
PUSH_DEV_OUTBOX=/tmp/orderloop-push.jsonl pnpm automation:demo   # [--email owner@demo.orderloop.test] [--sku DEMO-TEE-M]
```

It switches on `LOW_STOCK` for the seeded business, takes a variant above its reorder point and then below it, triggers the rule
through the same `AutomationService` as the API, delivers what was queued, prints the notifications and their deliveries, then
triggers again to show nothing is duplicated.

**By hand with the API** (sign in as the seeded owner first, see [api.md](api.md)):

```bash
curl -X PUT  localhost:4000/v1/automation/rules/LOW_STOCK -H "authorization: Bearer $T" -H 'content-type: application/json' \
  -d '{"enabled":true,"channels":{"email":true}}'
curl -X POST localhost:4000/v1/automation/rules/LOW_STOCK/run -H "authorization: Bearer $T" -H 'content-type: application/json' -d '{}'
curl localhost:4000/v1/notifications -H "authorization: Bearer $T"
curl "localhost:4000/v1/automation/deliveries?status=failed" -H "authorization: Bearer $T"
```

The scheduler fires on its own while the worker runs: a low-stock rule is evaluated in the next 5-minute bucket, a daily report at
the local time you set.

## Looking at failures, retrying, simulating failures

- **Failed runs:** `GET /v1/automation/runs?status=failed` (the `error` is short and scrubbed). `POST .../runs/:id/retry` queues it
  again; the retry resumes under the same slot, so nothing already announced is announced twice.
- **Failed deliveries:** `GET /v1/automation/deliveries?status=failed` shows `attempts` and `lastError`
  (`permanent:invalid_recipient...` will not retry by itself; `transient:...` is being retried by the queue). `POST
.../deliveries/:id/retry` queues one more try.
- **In the queue:** failed jobs stay a week under their deterministic id (`<ruleId>__<slot>`, `delivery__<id>`), visible in any
  BullMQ dashboard against Redis.
- **Simulate a failure.** Email: stop Mailpit (`docker stop orderloop-mailpit-1`) with `MAIL_PROVIDER=smtp`; deliveries go
  `failed` with `transient:` errors and are retried at 10 s, 20 s, 40 s, 80 s; start it again and the next retry sends (or press
  retry). Queue: stop Redis; an order is still created (the new-order event is lost) and the catch-up scan announces it within
  5 minutes. Worker crash: `kill -9` the worker mid-run; BullMQ redelivers (stalled job) and the claim takes over once. In tests
  all of these are driven directly (see below).

## Runbook

| Symptom                                       | Look at                                                                                                                                                                                                                                                      | Fix                                                                                                                                                    |
| --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| No notifications at all                       | Is the worker running? Log line `automation ready`; `automation.tick` lines every minute. Is the rule enabled (`GET rules`)? Does anyone hold the permission and have a channel on? A run with `skipped` and `skippedCount > 0` means nobody is a recipient. | Start the worker; enable the rule; check preferences.                                                                                                  |
| Runs `failed`                                 | `GET runs?status=failed` `error`; worker log `automation.run` with `outcome: failed`.                                                                                                                                                                        | Fix the cause (database reachable? migration applied?), then `POST runs/:id/retry`.                                                                    |
| Push says `sent` but nothing arrives          | `PUSH_PROVIDER` is `dev` (logs only). In production set `expo` and use a real device token.                                                                                                                                                                  | Set `PUSH_PROVIDER=expo` on **both** API and worker; devices registered under `dev` are skipped (`provider_mismatch`) until the phone registers again. |
| Deliveries stuck `pending`                    | The tick re-queues `pending` deliveries older than a minute. If the worker is down they wait.                                                                                                                                                                | Start the worker.                                                                                                                                      |
| Email `failed`, `permanent:invalid_recipient` | The address is refused (SMTP 5xx).                                                                                                                                                                                                                           | Fix the member's email; retry.                                                                                                                         |
| A report did not go out                       | `GET runs?kind=DAILY_REPORT`: is there a run for that local date? The slot is by local date in `tenants.timezone`; a report time that passed before the worker came back after local midnight is not sent.                                                   | Check the business's time zone and the worker's downtime; run it by hand (`POST .../run`).                                                             |
| Everyone got the same alert again             | An episode ended and restarted (stock recovered then dipped, an order left and re-entered the state): by design.                                                                                                                                             | None.                                                                                                                                                  |

## Known limits

- **At-least-once** at the one edge described above (a crash between the provider's acceptance and the `sent` mark).
- **Retention:** notifications, runs and deliveries are kept forever (no deletion by the application). A retention job is future work.
- **Order events from CSV import** are not queued; the 30-minute catch-up announces them (only orders created after the rule was
  switched on).
- **Skew:** "created before the rule was switched on" compares the database clock (orders) with the API's clock (the rule); a
  skew of a few milliseconds could drop an order created in the instant of switching the rule on.
- **Sign-out:** `POST /v1/auth/logout` does not know the phone's push token. A client must call `DELETE /v1/push-devices/:token`
  before signing out (online); a token that was not removed stops receiving pushes when the push service reports it dead.
- **Several phones, one delivery:** the push delivery of a person covers all their phones (see the edge above).
- **Expo receipts** are fetched once, 15 minutes after sending; a token that dies later is removed by the next push's ticket.
- No real SMS or WhatsApp vendor is integrated; the console provider only logs.
- A scan caps what it examines at 2,000 subjects per run (a digest names the top five anyway).

## What proves it

- Unit: `packages/domain/src/automation.test.ts` (`dueSlot` across Asia/Dhaka, Europe/London and America/New_York transitions,
  downtime, time-zone change, ISO weeks, scan slots, who receives what, the privacy scan of every builder and the push payload);
  `packages/contracts/src/automation.test.ts` (config schemas per kind, consent, tokens, error codes);
  `packages/automation/src/*.test.ts` (retry classification, job ids, the tick, the Expo and dev push providers, console
  messaging, warnings); `apps/worker/src/automation.test.ts` (the BullMQ wiring, the single scheduler, payload re-validation).
- Integration (real Postgres and Redis): `apps/api/test/automation.e2e.test.ts` (low stock once, concurrently, after recovery;
  delivery failure then retry; permanent failure; worker-crash simulations for runs and deliveries; new-order event and catch-up
  with a lost enqueue; unconfirmed cap; delayed; COD; report slots with a fake clock; permission matrix; tenant isolation of
  every new table and route; push device lifecycle; privacy scan end to end), `automation-messaging.e2e.test.ts` (provider and
  consent gating for SMS and WhatsApp), `automation-queue.e2e.test.ts` (real BullMQ workers: scheduler registration, deterministic
  ids, retry policy, the order event).
