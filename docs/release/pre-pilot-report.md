# Pre-pilot quality report (2026-10-21)

This is the result of the final quality milestone: what was checked, what the checks actually returned, what was fixed, and what is
still open. Numbers are from runs on 2026-10-21 on the working tree that contains everything described in
[dependencies-and-status.md](dependencies-and-status.md). Nothing here is a security certification, a legal compliance statement,
a statement that anything was published, or a statement that any external integration works live.

## Verdict

**The code passes every automated check run here, and the review findings that blocked a pilot are fixed. The product is not yet
ready for a pilot with real customers: the operational prerequisites in [known-limitations.md](known-limitations.md) section A
(B1 to B10) are open.** Of those, B1 (no deployment artifacts), B2 (no backup job or pilot-environment restore drill), B3 (no
monitoring or alerting), B5 (sign-up must be restricted by configuration) and B7 (real email delivery untested) must be closed
before any pilot; B4, B8, B9 and B10 depend on the pilot's scope (real couriers, push, mobile release, live Meta).

**Update, later on 2026-10-21 (deployment and operations work):** B1, B2, B3, B5 and B7 now have artifacts, tooling or code, and part of B4 has a read-only verification tool. **None of that changes the verdict**, because
each was exercised on a developer laptop only, and the pilot environment does not exist yet: deployment images and a Compose stack (run locally with `NODE_ENV=production`), an encrypted backup job and a restore drill (run locally, with failure cases),
metrics, alert rules and a monitoring profile (one alert fired locally, no real receiver), a production-required `REGISTRATION_MODE`, `pnpm mail:test` and `pnpm courier:verify` (never run against a real provider or courier). What was run and what was not is
in each row of [known-limitations.md](known-limitations.md) section A and in [../operations/deployment.md](../operations/deployment.md#14-what-was-tested-and-what-was-not). The checks in the table below were run **before** this work.

Criteria from the milestone brief, with evidence:

| Criterion                               | Status                                                                                                                                                  |
| --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Critical workflows work reliably        | Met in automated tests (web e2e and API integration below). Mobile workflows were checked by hand on a simulator and an emulator, only in part (below). |
| Tenant isolation tests pass             | Met: `tenant-isolation`, `workspaces`, `members` and the new per-feature isolation tests are in the 612 passing integration tests.                      |
| Financial calculations verified         | Verified by review plus tests; one real defect class (statement lines, audit before/after, partial returns) was found and fixed.                        |
| External dependencies clearly disclosed | Done: [dependencies-and-status.md](dependencies-and-status.md). None of the live integrations has been run against a real service.                      |

## Checks run, and the actual results

| Check                                                                          | Result                                                                                                                                                                                             |
| ------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm format:check`                                                            | pass (Playwright output folders added to `.prettierignore`)                                                                                                                                        |
| `pnpm check:versions`, `pnpm check:boundaries`                                 | pass                                                                                                                                                                                               |
| `pnpm lint`, `pnpm typecheck` (20 tasks each)                                  | pass                                                                                                                                                                                               |
| `pnpm turbo run build` (web, API, worker, mobile export, packages)             | pass                                                                                                                                                                                               |
| Unit tests                                                                     | contracts 81, courier-sdk 128, api-client 47, domain 183, ui 70, automation 84, mobile 30, worker 27, api 87, features 427: all pass                                                               |
| `node --test scripts/*.test.mjs`                                               | 12 pass                                                                                                                                                                                            |
| API integration suite (real PostgreSQL and Redis)                              | 612 pass in 35 files                                                                                                                                                                               |
| Web end-to-end (Playwright, real API, worker, PostgreSQL, Redis, mail catcher) | 85 pass, 1 skipped (the screenshot-capture spec, skipped by design)                                                                                                                                |
| `npx expo-doctor` (apps/mobile)                                                | 21/21                                                                                                                                                                                              |
| `pnpm audit --prod`                                                            | 4 advisories (2 high, 2 moderate): `node-forge`, `braces`, `uuid`, `decode-uri-component`; all reached only through mobile or build tooling, none in the API, worker or web runtime                |
| `pnpm inventory:verify` on the development database                            | ledger and stock levels agree (8 levels, 21 movements)                                                                                                                                             |
| Local restore drill (scratch database, then dropped)                           | identical row counts for all 45 tables; RLS, policies and functions identical; isolation holds as `app_user` (docs/operations/backup-and-restore.md). Not a drill from a pilot-environment backup. |

The web end-to-end run covers: registration and email verification, workspace setup and switching, inventory (products, stock,
damage, returns, imports and exports), orders (create, confirm, cancel, bulk, import, duplicate warning, idempotent create),
courier booking, COD reconciliation and finance, roles, theme, accessibility scans and phone-width layout on the main screens,
notifications and automation, and the Meta draft flow in mock mode.

### Mobile (iOS Simulator and Android emulator)

Checked by hand, on the development API with seed data, using Expo Go on the Android emulator and the project's own development
build on the iOS 27 simulator. Not a physical device and not a release build.

- **Checked:** sign-in, dashboard, orders list, customers list, notification bell and inbox (tap marks read and opens low stock),
  notification preferences, automation settings and "Run now", Integrations (mock banner, mock message to a draft), draft review,
  Social orders inbox, Bangla on the new screens (Android).
- **Not checked on a device:** creating an order in the mobile form, courier booking, COD reconciliation, the return dialog, push
  delivery. These are covered only by the web end-to-end tests and the shared unit tests.
- **Found and fixed while testing:** the app crashed at startup in Expo Go (and in an older development build) because
  `expo-notifications` and `expo-device` are native modules; Bengali text such as the name "রহিম উদ্দিন" lost its last word on
  Android in some row layouts (Android measures Bengali conjuncts narrower than it paints them); labels overflowed on Android.
  The Bengali fix adds invisible hair spaces after Bengali text on Android only (`packages/ui/src/Text.tsx`) and is covered by a unit
  test; it was verified on the emulator on the Customers list. It has not been re-verified on every screen, and the iOS renderer
  never showed the problem.
- **Launch logo:** the "other logo" seen at launch on Android is Expo Go's own splash. The project's icon files are correct (the
  adaptive icon was composited and checked; the iOS home screen shows the OrderLoop icon). Not verified: the splash of an Android
  development or release build, which needs a native build.

## What the reviews found, and what became of it

Two independent read-only reviews were run (security, and order/inventory/finance correctness). The full table is in
[known-limitations.md](known-limitations.md#findings-from-the-final-review). In short:

- **Security gate before fixes: FAIL** (1 High: a cubic-time phone parser reachable through customer messages and the default-on mock
  endpoints; 4 Medium; 11 Low). **After fixes:** the High and the Medium items are fixed with tests, apart from two that cannot be
  closed without outside action: live Meta signature verification (needs real credentials) and the residual forwarded-link case of
  the OAuth CSRF fix.
- **Correctness: no hard blocker**, but the financial audit trail was incomplete and three defects could silently distort money or
  stock (partial returns restocking the whole order, a shared payout id collapsing statement lines, no before/after values on
  order and price edits). All three are fixed with tests.
- **Found by the project's own verification, not by the reviews:** a sort bug in the new `inventory:verify` script and an e2e
  expectation that had been written around an extractor bug (Bangla "নাম রিনা" read with the cue word as part of the name).

## Open items that matter most

1. No deployment artifacts, backup job, restore drill from a pilot backup, monitoring or alerting (B1 to B3).
2. Real courier APIs, real email delivery and push delivery have never been exercised (B4, B7, B8).
3. Sign-up is open unless `REGISTRATION_MODE=allowlist` is set (B5). No account or customer deletion exists (B6).
4. The mobile app was never run on a physical device or as a release build (B9). Live Meta was never run and App Review has not
   started (B10).
5. Branch protection and required reviews are GitHub settings that must be switched on by hand; the CI workflow runs on every pull
   request but the repository settings were not changed from here.
6. A newly generated migration would sort before the existing ones (their folders are stamped later than today): use later
   timestamps.

## Not done in this milestone

- No physical-device test, no store build, no load or performance test beyond the targeted regression tests, no penetration test, no
  second independent review of the fixes, no screen-reader session (automated accessibility scans only, on the web).
- The CI changes (SHA-pinned actions, Dependabot, weekly audit, an https API URL for the mobile build job) were not run on GitHub:
  they have not been pushed from this tree.

## Update 2026-10-22: pilot blockers worked on

What changed since the report above, with the results of the final run on the merged tree (main merged in, including the
Dependabot updates for Actions and eleven npm packages). The earlier verdict stands, with a smaller list.

| Blocker                 | What now exists                                                                                                                                      | Evidence                                                                                                                                                                                                               | What is still missing                                                                                                       |
| ----------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| B1 Deployment artifacts | `deploy/` (Dockerfile for api, worker, web, migrate and ops images; compose for a single host; Caddy; secret generator; smoke test), CI `images` job | Images built and the whole stack run on a laptop under a throwaway project, healthy over HTTPS; `/health/ready` 200; sign-up and product creation through the stack; the CI job was **not yet seen running on GitHub** | A real host, real domain and TLS certificate, Linux, upgrade and rollback with data, image scanning                         |
| B2 Backups and restore  | `ops/backup.sh`, `ops/restore-drill.sh`, a backup service in compose, retention, age encryption                                                      | Local drill: 7 checks PASS, then dropped; failure cases (wrong key, corrupt file, wrong role, no key) all fail loudly; the RLS trap was reproduced (owner dumped 0 rows, backup role dumped them)                      | A drill from a pilot-environment backup, off-site upload, two named key custodians, WAL/PITR                                |
| B3 Monitoring           | `/metrics` (token-protected), worker health server, `ops/monitoring/` (16 alert rules, Alertmanager, Grafana)                                        | `promtool` rules check and 12 rule tests pass; Prometheus scraped 6/6 targets; stopping the worker fired two alerts in Prometheus and Alertmanager                                                                     | A real alert receiver (the webhook is a placeholder), tuned thresholds, log-based alerts, an external uptime probe          |
| B5 Sign-up              | `REGISTRATION_MODE` must be set explicitly in production; allowlist mode                                                                             | Unit and integration tests; the smoke run showed 403 `registration_closed` and 201 for a listed email                                                                                                                  | Choosing the allowlist and the pilot emails (configuration)                                                                 |
| B6 Deletion             | Customer erasure, account deletion, business deletion with grace period and hourly purge, customers CSV export, `/data-deletion` page                | 642 integration tests including column-by-column scans for leftover personal data and a purge of every tenant table; six browser tests                                                                                 | Legal review, backup retention policy, settlements export, the purge exercised against real Redis in a deployed environment |
| B7 / B4 tooling         | `pnpm mail:test`, `pnpm courier:verify`                                                                                                              | Unit tests with fakes; `mail:test` delivered through a local STARTTLS server                                                                                                                                           | **Not run against a real SMTP provider or a real courier account**                                                          |

**Still open and not fixable from the repository:** B4 (real courier APIs), B7 (real email delivery), B8 (push on a physical
device), B9 (mobile release build and a physical device), B10 (live Meta, App Review).

### Results of the final run (merged tree, 2026-10-22)

| Check                                                                 | Result                                                                                                                                                                                                                                                          |
| --------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm format:check`, `check:versions`, `check:boundaries`             | pass                                                                                                                                                                                                                                                            |
| `pnpm lint`, `pnpm typecheck` (22 tasks each), `pnpm turbo run build` | pass                                                                                                                                                                                                                                                            |
| Unit tests                                                            | contracts 97, observability 17, courier-sdk 128, api-client 47, domain 184, ui 70, automation 84, worker 42, api 114, features 472, mobile 30: all pass                                                                                                         |
| `node --test scripts/*.test.mjs`                                      | 22 pass                                                                                                                                                                                                                                                         |
| API integration suite                                                 | 642 pass in 38 files                                                                                                                                                                                                                                            |
| Web end-to-end                                                        | 92 pass, 1 skipped (the screenshot spec, by design)                                                                                                                                                                                                             |
| `npx expo-doctor`                                                     | 21/21 after applying three Expo SDK 57 patch releases published that day (`expo`, `expo-network`, `expo-router`) with `expo install --fix`; this added their exact versions to `minimumReleaseAgeExclude` in `pnpm-workspace.yaml`, as earlier Expo updates had |

Two test problems were found and fixed on the way: a 50 ms timing assertion that failed on a busy CI runner (now 500 ms), and two
setup mistakes in the new deletion browser spec (the owner's email had to be verified before inviting a member).

### Dependency updates handled

Dependabot's first npm update would have moved `react-native` from 0.86.3 to 0.88.0, which Expo SDK 57 does not support (the
mobile bundle failed in CI). It was not merged; React, React Native, Expo and TypeScript are now excluded from Dependabot and move
only with an Expo SDK upgrade. The recreated update (eleven runtime packages, including express, next and prisma patch and minor
releases) and the GitHub Actions update passed `verify`, `e2e` and `mobile` and were merged. The weekly `audit` check still fails
on the four known advisories in mobile and build tooling.
