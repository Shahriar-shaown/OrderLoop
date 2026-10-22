# Controlled pilot: go / no-go checklist

A gate list for a **controlled pilot** (a few named businesses, closely watched, reversible). Nothing here is pre-checked: every item
starts unchecked and is ticked only with the **evidence** named beside it (a link, log excerpt, screenshot or command output stored in
the release record). Items the project cannot know (accounts, contracts, hosting, people) are left for the pilot owner.

Sizes, numbers and thresholds marked "proposed" are suggestions, not commitments. This checklist does **not** certify security, privacy
or legal compliance, and does not assert that any store, Meta, courier or push integration has been published or verified live.
Status of each feature: [dependencies-and-status.md](dependencies-and-status.md). Known problems: [known-limitations.md](known-limitations.md).

Decision: **GO** only if every item in sections 1 to 4 that applies to the agreed pilot scope (section 5) is checked, and the
rollback criteria (section 6) and exit criteria (section 7) are agreed in writing. Anything unchecked is a **NO-GO** unless the pilot owner
signs a written exception naming the risk.

Release record: version/tag `<…>`, date `<…>`, pilot owner `<…>`, approver `<…>`.

**Local-rehearsal evidence.** On 2026-10-21 the deployment, backup and monitoring tooling was exercised on a developer laptop (`deploy/smoke-test.sh`; see [../operations/deployment.md](../operations/deployment.md#14-what-was-tested-and-what-was-not)).
An item marked `[x]` with "**local rehearsal only**" has that evidence and nothing more: it proves the tooling works, not that the **pilot environment** is right, so **repeat it on the pilot hosts before GO** (it does not satisfy the gate by itself).
Items with a "Local evidence" note but still `[ ]` were partly exercised. Everything else is untouched and unchecked.

## 1. Technical gates

Run from a clean checkout of the release tag on a machine with Docker (`pnpm services:up`, `pnpm services:mail`, `pnpm db:init`).

- [ ] **Static and unit checks green.** `pnpm check` (= format check, version drift, import boundaries, lint, typecheck, test, build). _Evidence: full output or the CI run link for the tag._
- [ ] **CI green on the tag**: jobs `verify`, `mobile`, `e2e` and `images` in `.github/workflows/ci.yml` (`images` builds the deployment images and validates the compose file and monitoring rules; it has not been seen running on GitHub yet). _Evidence: CI run link._ (The workflow has not been recorded as run in the repository docs; confirm.)
- [ ] **Integration tests green** against PostgreSQL 16 and Redis 7: `pnpm test:integration` (includes the tenant-isolation suite, logging redaction, couriers, finance, automation, Meta). _Evidence: output._
- [ ] **Browser tests green**: `pnpm --filter @orderloop/web test:e2e` (real Chrome, with the accessibility scan). _Evidence: output / report._
- [ ] **Mobile bundles and native projects build**: `pnpm --filter @orderloop/mobile exec expo export --platform ios --platform android --output-dir /tmp/mobile-export` and `expo prebuild` with `APP_VARIANT=production` (the CI `mobile` job). _Evidence: output._
- [ ] **Migrations apply from empty and on a copy of the pilot database**: `pnpm db:init` on an empty database; `pnpm db:migrate:deploy` and `pnpm --filter @orderloop/db run migrate:status` on a restored copy. _Evidence: outputs._ ([../operations/migrations.md](../operations/migrations.md))
- [ ] **No schema drift**: `prisma migrate diff --from-config-datasource --to-schema prisma/schema.prisma --exit-code` prints `No difference detected.` on the target database. _Evidence: output._
- [ ] **OpenAPI is current**: `pnpm --filter @orderloop/api openapi` leaves `docs/openapi.json` unchanged (a test also fails when stale). _Evidence: clean `git status`._
- [x] **Production configuration starts**: api and worker start with the production environment (`NODE_ENV=production`, real keys, `MAIL_PROVIDER=smtp`) and report ready; `GET /health/ready` is 200. _Evidence: start-up logs (secrets removed) and curl output._ ([../operations/deployment.md](../operations/deployment.md)) **Local rehearsal only (2026-10-21):** api and worker started with `NODE_ENV=production`, generated keys, `MAIL_PROVIDER=smtp` with STARTTLS, `REGISTRATION_MODE=allowlist`, and `/health/ready` through Caddy was 200 (`deploy/smoke-test.sh`, transcript in deployment.md section 14). The same step proved the production safeguards: the API exits with a JSON `unhandled_error` line listing every bad variable when the environment is invalid.
- [ ] **Deployed stack smoke test passed** on the pilot hosts, using the dedicated test business. _Evidence: the filled smoke-test list from deployment.md section 12._ _Local evidence (2026-10-21):_ `deploy/smoke-test.sh` passed on a laptop; not done on a pilot host.
- [ ] **Worker running and processing** in the deployed environment: `automation.tick` every minute; a CSV import reaches `COMPLETED`; a rule notification appears. _Evidence: log lines, screenshots._ _Local evidence:_ worker `/health/ready` 200 and heartbeat fresh; `automation-tick`, `meta-health` and `tenant-purge` jobs completed in the worker's own metrics; a CSV import and a rule notification were not exercised.
- [ ] **Release is tagged** and the previous known-good tag exists with a retained build artifact for rollback. _Evidence: tag names, artifact locations._ _Local evidence:_ images are built locally from a checkout (`IMAGE_TAG`); CI job `images` builds them on every push but pushes nothing, so no per-tag artifact is retained.
- [ ] **Monitoring alerts configured and tested** (minimum set in [../operations/monitoring.md](../operations/monitoring.md)): readiness, 5xx rate, worker `automation.tick` missing, queue age, backup age, disk. One alert deliberately fired. _Evidence: alert configuration and the test notification._ _Local evidence (2026-10-21):_ rules and Alertmanager config validated, `promtool test rules` passed (12 cases), and one alert (worker stopped) was fired for real and reached Alertmanager; **no receiver is configured**, thresholds untuned, no external uptime probe, so not ticked ([../operations/monitoring.md](../operations/monitoring.md)).
- [ ] **Log access and retention set** (30 days online proposed); logs checked for secrets/PII after a smoke test. _Evidence: retention setting, a grep result of the smoke-test logs._

## 2. Security gates

- [ ] **Secrets are only in the secret manager/environment**: not in git history, CI logs or images. _Evidence: secret-scan output over the repository history and the build logs; list of where each secret lives._
- [ ] **Production keys generated for this environment**: `JWT_PRIVATE_KEY`/`JWT_PUBLIC_KEY` (no development key), `COURIER_CREDENTIALS_KEY` (32 bytes), strong DB passwords, none from `.env.example`. _Evidence: key ids/creation dates (never the values)._ _Tool:_ `deploy/generate-secrets.sh` generates all of them without printing and writes mode-600 files (checked locally); run it on the pilot host.
- [x] **Runtime database role is confined**: `DATABASE_URL` is `app_user`; as `app_user`, tables return 0 rows without tenant context; `app_user` is not superuser/owner/`BYPASSRLS`; 39 tenant tables have forced RLS (compare with `TENANT_TABLES`). _Evidence: the queries and output from backup-and-restore.md section 6 (steps 4 and 5) on the **production** database._ **Local rehearsal only:** the restore drill connected as `app_user` to a restored copy: no tenant context saw 0 rows, one tenant's context saw exactly its rows, another tenant's id saw 0 (`ops/restore-drill.sh`, [../operations/backup-and-restore.md](../operations/backup-and-restore.md#drill-performed-on-2026-10-21-local)); 39 tables had forced RLS, equal to the manifest. Repeat on the pilot database.
- [ ] **Tenant isolation suite green** (`apps/api/test/tenant-isolation.e2e.test.ts`, part of `pnpm test:integration`). _Evidence: output._
- [ ] **HTTPS only**: valid certificates on API and web hosts; HTTP redirects; API cookies `Secure`; HSTS present; TLS expiry monitored. _Evidence: header dump, certificate check._ _Local evidence:_ Caddy (internal CA) redirected HTTP with 308, served both hosts over TLS, and the apps' own HSTS and CSP headers reached the client; Let's Encrypt and certificate-expiry monitoring were not tested.
- [ ] **`WEB_ORIGINS` is the exact web origin(s)** (no wildcard, no localhost); web and API on the same registrable domain; sessions persist across reload. _Evidence: env review, browser test._
- [ ] **`TRUST_PROXY` equals the real hop count**; a request through the proxy logs the real client IP and a rate limit applies per client. _Evidence: log line, repeated-request test._ _Note:_ the compose file sets `TRUST_PROXY=1` (one Caddy hop); not verified against a real client IP.
- [ ] **Rate limiting enabled** (`RATE_LIMIT_ENABLED` not `false`); single API instance, or a shared limiter decision recorded for more instances (limits are per instance). _Evidence: env review._
- [ ] **Development behaviours off**: `/api-docs` returns 404; `MAIL_PROVIDER` is `smtp`; `PUSH_DEV_OUTBOX` unset; `COURIER_MOCK_ENABLED` and `META_MODE` decided deliberately (section 5); no seed data; no demo accounts with the documented throwaway password. _Evidence: curl and env review._
- [ ] **Webhook endpoints verified**: a request without signature/secret returns 401, never 5xx; Meta route 404/401 as documented; courier route answers 401 uniformly. _Evidence: curl outputs._
- [ ] **Log redaction check**: after exercising sign-in, reset, invitation, courier credentials, Meta connect: no passwords, tokens, emails, phone numbers or addresses in api/worker logs. _Evidence: grep results._ (Worker plain-text lines are not scrubbed: see monitoring.md.)
- [ ] **Dependency vulnerability scan** run on the lockfile with the tool of your choice (`pnpm audit` or a scanner); high/critical findings triaged. _Evidence: report._ (No scan is wired into CI.)
- [ ] **Independent security review and correctness review findings are closed or accepted in writing.** _Evidence: see "Findings from the final review" in [known-limitations.md](known-limitations.md); every Blocker/High item has a fix, or a signed risk acceptance._
- [ ] **No external penetration test has been performed by the project.** Decide whether the pilot proceeds without one. _Evidence: signed decision._
- [ ] **Access control for operations**: named people only have the admin DB role, secrets and server access; MFA on the cloud/DB/DNS/Expo/Meta/courier accounts. _Evidence: access list._
- [ ] **Incident contacts filled in** (the placeholders in [../operations/incident-response.md](../operations/incident-response.md)), on-call named for the monitoring window. _Evidence: the filled table._
- [ ] **Privacy basics**: a privacy policy and terms exist and are linked where users sign up; pilot businesses were told what customer data the app stores and where it is hosted. The project asserts no legal compliance; counsel review is the owner's. _Evidence: published policy URL; pilot agreement._

## 3. Data and backup gates

- [x] **Automated backups run** (provider PITR and/or nightly `pg_dump` by a role that bypasses RLS). _Evidence: job config, newest backup timestamp._ **Local rehearsal only:** `ops/backup.sh` ran (at container start and by hand), produced an encrypted dump and manifest, applied retention, reported to monitoring, and `backup-health.sh` went healthy. Nightly scheduling on the pilot host was not observed.
- [x] **A backup was verified complete** (row counts equal; not an `--enable-row-security` dump). _Evidence: count diff._ **Local rehearsal only:** manifest row counts (taken from the dump's own snapshot) equalled every restored table's count (45 tables, 51 rows); the same table dumped by the owner role with `--enable-row-security` held 0 rows against 4 by `app_backup`.
- [ ] **A restore drill was performed from a real pilot-environment backup** into a scratch database, measured, with tenant isolation and `migrate:status` checked (the only drill so far is a local one on 2026-10-21 against development data). _Evidence: completed checklist from [../operations/backup-and-restore.md](../operations/backup-and-restore.md#restore-test-checklist)._ _Local evidence:_ a full drill with PASS and five failure cases on 2026-10-21; not from a pilot-environment backup.
- [ ] **RPO/RTO agreed** with the pilot businesses (proposed: 15 min / 4 h with PITR; 24 h / 4 h with nightly dumps) and written in the pilot agreement. _Evidence: agreement._
- [ ] **Key custody**: `COURIER_CREDENTIALS_KEY` and JWT keys backed up **separately from database dumps**, two custodians named, recovery tested. _Evidence: custody record, drill decrypt result._ _Note:_ the backup private key is created by `deploy/generate-secrets.sh` for you to move off the host; nobody is named custodian yet.
- [ ] **Backups encrypted and off-host**; retention and deletion statement written (backups outlive deletion requests). _Evidence: configuration, statement._ _Local evidence:_ encrypted with `age` to a public key (the host holds no decryption key); an off-host copy via `rclone` is implemented but was never run against a real bucket.
- [ ] **Migrations are additive for this release** and a backup was taken immediately before the production migration. _Evidence: migration review, backup id._
- [ ] **Data deletion process agreed** (Meta callbacks configured if Meta is live; manual process for a business or customer request; no automated tooling exists). _Evidence: written procedure and owner._
- [ ] **No real customer data in non-production environments**; the pilot starts with fictional/test businesses only until the smoke test is signed. _Evidence: statement._
- [ ] **Export path tested**: a pilot business can export its orders, products and stock as CSV and the file opens correctly (Bangla text, phone numbers). _Evidence: sample exports with fictional data._

## 4. External dependency gates

Tick only the rows that are inside the agreed pilot scope; write "out of scope" next to the others.

- [ ] **SMTP**: a real provider account, verified sending domain (SPF, DKIM, DMARC), `MAIL_FROM` allowed; verification, password-reset and invitation emails delivered to real inboxes (Gmail and one local provider) and not in spam. _Evidence: headers/screenshots._ (Tested only with Mailpit so far.) _Tools:_ `pnpm mail:test -- --to <address>` and the SPF/DKIM/DMARC steps and deliverability checklist in [../operations/deployment.md](../operations/deployment.md#email-setup-spf-dkim-dmarc-and-a-test-send); **never run against a real provider**.
- [ ] **DNS, TLS, hosting, database, Redis** provisioned with named owners and support contacts. _Evidence: inventory._
- [ ] **Couriers** (only if live booking is in scope): per courier, the [first-contact checklist](../couriers.md#first-contact-with-a-real-courier) completed with real credentials (Pathao sandbox before live; Steadfast has no sandbox, so one real parcel that can be cancelled), including a webhook delivery. Any response that differs from the code was fixed and re-tested. _Evidence: the recorded results and ids (redacted)._ If not done: live booking is **out of scope** and businesses book in the courier panel (or use the simulated courier, clearly labelled). _Tool:_ `pnpm courier:verify -- --provider pathao|steadfast` (read-only; [../operations/deployment.md](../operations/deployment.md#verify-a-courier-with-real-credentials-first-contact)); **never run against a real or sandbox account**.
- [ ] **Courier statements** (only if finance reconciliation is in scope): a real statement was rearranged into OrderLoop's CSV format and imported successfully; the business understands there is no automatic mapping. _Evidence: result with redacted data._
- [ ] **Meta** (only if live Facebook/Instagram is in scope): the 12-step activation checklist in [../meta.md](../meta.md#activation-checklist) completed with authorised test accounts that have a role on the Meta app; App Review status recorded (until approved, only app role holders can connect). If not done: `META_MODE=mock` and Meta is **out of scope**. _Evidence: dashboard screenshots, test conversation._
- [ ] **Push** (only if phone push is in scope): EAS project, FCM credentials, Apple push key, `PUSH_PROVIDER=expo` on api **and** worker, a push delivered to a physical Android and iPhone from a real event. If not done: `PUSH_PROVIDER=dev` and pilot users are told notifications are in-app and email only. _Evidence: device screenshots._
- [ ] **Mobile distribution** (only if the mobile app is in scope): a `preview` build (internal distribution) installed on real devices of each pilot user with the production API URL (no `example.com`), sign-in and one order flow verified per platform. Store publication is **not** part of a controlled pilot unless separately approved. _Evidence: device test notes._
- [ ] **SMS/WhatsApp**: out of scope (no vendor integrated). _Evidence: `SMS_PROVIDER=none`, `WHATSAPP_PROVIDER=none`._

## 5. Pilot scope and guardrails

Fill in and agree these before go-live; the proposed values are starting points.

- [ ] **Businesses**: `<3 to 5>` named businesses, each with a named owner and a signed pilot agreement (set `REGISTRATION_MODE=allowlist` and `REGISTRATION_ALLOWED_EMAILS`: the API refuses to start in production without an explicit choice, and other emails get 403 `registration_closed`; verified locally, not on the pilot host). _Evidence: list._
- [ ] **Features in scope** (tick): web app ☐, mobile preview build ☐, simulated courier ☐, live Pathao ☐, live Steadfast ☐, Meta live ☐, push ☐, settlement import ☐, automation email/in-app ☐. Everything else is out of scope and stated as such to the businesses.
- [ ] **Data volumes capped** (proposed: <= 50 orders/day per business; catalog <= 2,000 variants); no load test has been done by the project. _Evidence: agreement, or a load test result._
- [ ] **Monitoring window**: engineer on call for the first `<14>` days, business hours plus a morning and evening check; proposed daily review of failed runs/deliveries, queue age, `booking_uncertain` shipments, Meta connection status. _Evidence: rota._
- [ ] **Support process**: one channel and one named responder per business, response target (proposed: 2 h business hours), a way to report with the `x-request-id`/time/business. _Evidence: published support instructions._
- [ ] **Feedback loop**: a weekly 30-minute review with each business, a shared issue list, severities per [../operations/incident-response.md](../operations/incident-response.md#1-severity-levels). _Evidence: calendar, tracker._
- [ ] **Money guardrails**: businesses are told finance figures are **estimates** (profit, outstanding COD); no one should stop reconciling in their own books; no bank reconciliation exists. _Evidence: onboarding note._
- [ ] **Courier guardrails**: first live bookings are watched one at a time; businesses know cancelling at Pathao/Steadfast happens in the courier panel; `booking_uncertain` must be settled by a person. _Evidence: onboarding note._
- [ ] **Kill switch known**: how to stop each part (disable a courier connection, set `META_MODE=mock` and disconnect, stop the worker, put the API in maintenance) and who may do it. _Evidence: runbook link._

## 6. Rollback criteria

Roll back (or pause the pilot) if any of these happens; the incident commander decides, the pilot owner is told immediately.

- [ ] **Agreed in advance**: cross-business data exposure, or a credible suspicion of it.
- [ ] Any **loss of committed business data**, or a restore that loses more than the agreed RPO.
- [ ] **Wrong or duplicate courier bookings** that reach the courier more than once (stop live booking at once).
- [ ] **Wrong money figures** acted on by a business that cannot be corrected the same day.
- [ ] **Sign-in or order creation unavailable** for more than `<2 h>` in business hours, or readiness failing for more than `<30 min>`.
- [ ] **Worker down** or queues not draining for more than `<1 h>`.
- [ ] A **credential or key leak** that cannot be contained by rotation within `<4 h>`.
- [ ] An **unrecoverable bad deploy** (rollback not possible; schema change not additive).
- [ ] Rollback steps rehearsed once on staging: previous tag redeploy, schema left in place, smoke test. _Evidence: rehearsal notes._ ([../operations/incident-response.md](../operations/incident-response.md#bad-deploy-rollback))

## 7. Exit criteria (pilot to wider release)

Decide at the end of the monitoring window (proposed `<4 to 6 weeks>`); record the decision and who made it.

- [ ] No SEV1 incident open; every SEV1/SEV2 has a completed post-incident review with actions done or scheduled.
- [ ] No unresolved cross-tenant, credential or money-correctness defect.
- [ ] **Restore drill from pilot data repeated** and the measured RTO is within the agreed target.
- [ ] Backups ran every night (or PITR window continuous) for the whole period; alerts fired and were handled during the period.
- [ ] Every `booking_uncertain`, failed delivery and Meta `needs_reconnect` event was explained.
- [ ] Each pilot business reports (written) that it ran real orders in the app for at least `<2>` weeks; satisfaction and top-3 pain points collected.
- [ ] All items in [known-limitations.md](known-limitations.md) marked **Blocker for pilot** are fixed, and every "Should fix soon" item has an owner and date.
- [ ] External dependencies promoted from "mock/awaiting" to verified, or consciously left out of the wider release, with the status table updated.
- [ ] For store release: store requirements in deployment.md section 11 (privacy answers, account deletion flow, review accounts) done.
- [ ] Capacity observations recorded (requests, database size, queue behaviour) and the single-API-instance limit reviewed.
