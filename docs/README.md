# OrderLoop documentation

## Product and design

| Doc                                                | What it covers                                                                                |
| -------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| [implementation-plan.md](implementation-plan.md)   | Phased plan and per-milestone status                                                          |
| [architecture.md](architecture.md)                 | Decisions, boundaries, authentication, tenant isolation, risks                                |
| [database.md](database.md)                         | Data model, row-level security, roles, migrations, seed data                                  |
| [api.md](api.md)                                   | API concepts, auth flows, errors, idempotency, rate limits, email, logging, env               |
| [openapi.json](openapi.json)                       | Generated OpenAPI description (also served at `/openapi.json`)                                |
| [permissions.md](permissions.md)                   | Roles, permissions per route, audit trail                                                     |
| [orders.md](orders.md)                             | Orders, customers, status machine                                                             |
| [inventory.md](inventory.md)                       | Stock ledger, reservations, locations                                                         |
| [couriers.md](couriers.md)                         | Pathao, Steadfast, simulated courier; what is verified and what is not                        |
| [finance.md](finance.md)                           | COD reconciliation, settlement import, estimated profit                                       |
| [dashboard.md](dashboard.md)                       | Dashboard figures                                                                             |
| [automation.md](automation.md)                     | Rules, notifications, scheduling, delivery, runbook                                           |
| [privacy-and-deletion.md](privacy-and-deletion.md) | Erasing a customer, deleting an account or a business: what goes, what stays, backups, limits |
| [meta.md](meta.md)                                 | Facebook Page and Instagram draft orders; activation checklist                                |
| [web.md](web.md)                                   | Web app, shared UI, browser tests                                                             |
| [mobile.md](mobile.md)                             | Mobile app, builds, push, offline, language                                                   |
| [design/](design/README.md)                        | UI guide and Figma exports                                                                    |
| [known-issues.md](known-issues.md)                 | Review findings deliberately left open, with reasons                                          |

## Operations (running it)

| Doc                                                                  | What it covers                                                                                                                                                |
| -------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [operations/deployment.md](operations/deployment.md)                 | Single-host Docker deployment (tested locally only), environment variables, secrets, reverse proxy, email and courier checks, mobile release path, smoke test |
| [operations/free-deployment.md](operations/free-deployment.md)       | Free tunnel for real Meta/TikTok tests, and a free always-on VM deployment                                                                                    |
| [operations/migrations.md](operations/migrations.md)                 | Authoring and applying migrations, rules, rollback, the dev-database caveat                                                                                   |
| [operations/backup-and-restore.md](operations/backup-and-restore.md) | Encrypted backups, the restore drill and its local result, the RLS trap, key custody                                                                          |
| [operations/monitoring.md](operations/monitoring.md)                 | Health endpoints, metrics, alert rules and the monitoring stack (tested locally), logs, what is missing                                                       |
| [operations/incident-response.md](operations/incident-response.md)   | Severity, roles, first 15 minutes, runbooks, templates                                                                                                        |

## Release (pilot)

| Doc                                                                      | What it covers                                                      |
| ------------------------------------------------------------------------ | ------------------------------------------------------------------- |
| [release/pilot-checklist.md](release/pilot-checklist.md)                 | Go / no-go checklist for a controlled pilot, with evidence per item |
| [release/dependencies-and-status.md](release/dependencies-and-status.md) | Every feature and integration: real, mock, awaiting, not built      |
| [release/known-limitations.md](release/known-limitations.md)             | Prioritised limitations and fixes, with the final-review findings   |
| [release/pre-pilot-report.md](release/pre-pilot-report.md)               | Results of the pre-pilot checks, review findings and the verdict    |
