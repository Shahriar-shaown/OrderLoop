# Businesses, roles and permissions

Everything a person sees or changes in OrderLoop happens inside **one business** (the code calls it a _tenant_; the screens
say _business_ or _workspace_: same thing). This document is the reference for who may do what, and for how the API keeps one
business's data away from another's.

## Vocabulary

| Product word        | Code                          | Notes                                                                   |
| ------------------- | ----------------------------- | ----------------------------------------------------------------------- |
| Business, workspace | `Tenant` / `tenants`          | Name, logo link, contact, address, currency, time zone, language.       |
| Membership          | `Membership`/`memberships`    | One row per (person, business) with a **role**. Roles are never global. |
| Switching workspace | `POST /v1/auth/switch-tenant` | Starts a **new session** in another business the person belongs to.     |

Defaults for a new business: currency `BDT`, time zone `Asia/Dhaka`, language `en` (Bangla is `bn`). A person also has their
own language preference (`PATCH /v1/me`), which follows them into every business. Screen translations are not shipped yet;
both preferences are stored and returned so the screens can use them as translations arrive.

## Roles and permissions

| Permission          | OWNER | ADMIN | MANAGER | STAFF | ACCOUNTANT |
| ------------------- | :---: | :---: | :-----: | :---: | :--------: |
| `tenant:read`       |  yes  |  yes  |   yes   |  yes  |    yes     |
| `tenant:update`     |  yes  |  yes  |   no    |  no   |     no     |
| `members:read`      |  yes  |  yes  |   yes   |  no   |    yes     |
| `members:invite`    |  yes  |  yes  |   no    |  no   |     no     |
| `members:manage`    |  yes  |  yes  |   no    |  no   |     no     |
| `audit:read`        |  yes  |  yes  |   no    |  no   |     no     |
| `catalog:read`      |  yes  |  yes  |   yes   |  yes  |    yes     |
| `catalog:write`     |  yes  |  yes  |   yes   |  no   |     no     |
| `inventory:read`    |  yes  |  yes  |   yes   |  yes  |    yes     |
| `inventory:write`   |  yes  |  yes  |   yes   |  yes  |     no     |
| `orders:read`       |  yes  |  yes  |   yes   |  yes  |    yes     |
| `orders:write`      |  yes  |  yes  |   yes   |  yes  |     no     |
| `couriers:read`     |  yes  |  yes  |   yes   |  yes  |    yes     |
| `couriers:manage`   |  yes  |  yes  |   no    |  no   |     no     |
| `finance:read`      |  yes  |  yes  |   yes   |  no   |    yes     |
| `finance:import`    |  yes  |  yes  |   no    |  no   |    yes     |
| `finance:adjust`    |  yes  |  yes  |   no    |  no   |     no     |
| `automation:read`   |  yes  |  yes  |   yes   |  no   |     no     |
| `automation:manage` |  yes  |  yes  |   no    |  no   |     no     |

The brief asked for owner, admin, manager and staff. `ACCOUNTANT` (read-only finance access) was added in an earlier
milestone and is kept.

The matrix lives in one place, `packages/domain/src/permissions.ts`, and a test pins it. Adding a role or permission changes
that file only; the API, the web app and the mobile app all read it.

### Who may assign which role

Holding `members:invite` or `members:manage` is not enough to grant any role:

- An **OWNER** may invite, change and remove anyone.
- An **ADMIN** may only invite, change or remove **MANAGER**, **STAFF** and **ACCOUNTANT**. An admin cannot create, change or
  remove owners or admins, and cannot promote anyone above their own reach.
- A business always keeps at least one **OWNER**: demoting or removing the last one is refused, even under concurrent requests.
- Nobody can invite someone into a role they may not assign. Inviting needs a verified email address.

### Route by route

Every protected route is declared once in `packages/contracts/src/routes.ts` with its permission. A test fails if a protected
route has no permission and is not on the short list of self-service routes (which act on the caller's own session,
preferences or memberships, never on business data).

| Route                                                                                                                                                                                                                         | Needs                                                                                              |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| `POST /v1/auth/logout`                                                                                                                                                                                                        | any member                                                                                         |
| `POST /v1/auth/switch-tenant`                                                                                                                                                                                                 | any member of the _target_ business                                                                |
| `POST /v1/auth/resend-verification`                                                                                                                                                                                           | any member                                                                                         |
| `GET /v1/me`, `PATCH /v1/me`                                                                                                                                                                                                  | any member                                                                                         |
| `GET /v1/workspaces`                                                                                                                                                                                                          | any member (lists the caller's own businesses only)                                                |
| `POST /v1/workspaces`                                                                                                                                                                                                         | any member (caller becomes OWNER of the new business; at most 10 owned)                            |
| `GET /v1/tenant`                                                                                                                                                                                                              | `tenant:read`                                                                                      |
| `PATCH /v1/tenant`                                                                                                                                                                                                            | `tenant:update`                                                                                    |
| `GET /v1/members`                                                                                                                                                                                                             | `members:read`                                                                                     |
| `GET/POST /v1/members/invitations`, `DELETE /v1/members/invitations/:id`                                                                                                                                                      | `members:invite`                                                                                   |
| `PATCH/DELETE /v1/members/:id`                                                                                                                                                                                                | `members:manage`                                                                                   |
| `GET /v1/dashboard` (its `profit` is `null` without `finance:read`); `GET` orders, customers, order duplicates, customer order history, orders export; `POST /v1/orders/duplicate-check`                                      | `orders:read`                                                                                      |
| `POST/PATCH` orders and customers, customer addresses, order status, bulk status, orders import (check and apply)                                                                                                             | `orders:write`                                                                                     |
| `GET` couriers, an order's shipments, a shipment, `GET /v1/shipments` (the list), `GET /v1/shipment-stats`                                                                                                                    | `couriers:read`                                                                                    |
| `PATCH/DELETE /v1/couriers/:provider`, `POST /v1/couriers/:provider/test`                                                                                                                                                     | `couriers:manage`                                                                                  |
| courier places, shipping quote, book / refresh / cancel / settle / simulate a shipment                                                                                                                                        | `orders:write`                                                                                     |
| `POST /v1/shipments/:id/resolve` with outcome `not_booked` or `cancelled_at_courier` (those let the order be booked again)                                                                                                    | `orders:write` **and** `couriers:manage`                                                           |
| `POST /v1/webhooks/couriers/:provider/:tenantId/:connectionId`                                                                                                                                                                | public; the courier's own proof (see [couriers.md](couriers.md))                                   |
| `GET` settlements, outstanding COD, discrepancies, costs, finance summary, `GET /v1/finance/analytics`, `GET /v1/orders/:id/cash`                                                                                             | `finance:read`                                                                                     |
| import a settlement, re-check, reconcile a settlement                                                                                                                                                                         | `finance:import`                                                                                   |
| match / undo / ignore a statement line, resolve or waive a discrepancy, record or void a cost                                                                                                                                 | `finance:adjust`                                                                                   |
| `GET /v1/audit-logs`                                                                                                                                                                                                          | `audit:read`                                                                                       |
| `GET /v1/automation/rules`, `GET /v1/automation/runs`, `GET /v1/automation/deliveries`                                                                                                                                        | `automation:read`                                                                                  |
| `PUT /v1/automation/rules/:kind`, `POST /v1/automation/rules/:kind/run`, `POST /v1/automation/runs/:id/retry`, `POST /v1/automation/deliveries/:id/retry`                                                                     | `automation:manage`                                                                                |
| `GET /v1/notifications`, `/unread-count`, `POST /v1/notifications/:id/read`, `/read-all`, `GET/PUT /v1/notification-preferences`, `POST /v1/push-devices`, `DELETE /v1/push-devices/:token`, `GET/PUT /v1/messaging-consents` | any member (the caller's **own** notifications, choices, phones and consent; never other people's) |
| `GET` categories, products, product by id, suppliers, `GET /v1/exports/products`                                                                                                                                              | `catalog:read`                                                                                     |
| `POST/PATCH/DELETE` categories, `POST/PATCH` products and variants, `POST/PATCH` suppliers, `POST/PATCH /v1/locations`, product imports                                                                                       | `catalog:write`                                                                                    |
| `GET /v1/locations`, `/v1/inventory`, `/v1/inventory/summary`, `/v1/inventory/movements`, `/v1/inventory/low-stock`, `/v1/reservations`, `/v1/exports/stock`                                                                  | `inventory:read`                                                                                   |
| `POST` receive, adjust, damage, write-off, return, reserve, release, fulfil                                                                                                                                                   | `inventory:write`                                                                                  |

The generated, always-current list is `docs/openapi.json` (each protected operation carries its permission).

**Cost prices are visible by design** to anyone with `catalog:read` or `inventory:read` (a variant's `costMinor`, the stock
export, the product list): the people who receive stock and price products need them, and that includes STAFF. What needs
`finance:read` is everything derived from sales: profit, revenue, margins, settlements, costs and COD cash. If a business must hide
cost prices from some roles, that is a new permission, not a setting that exists today.

## How the business boundary is enforced

Five independent layers, so a bug in one does not open a hole:

1. **Every business-owned record carries a business.** Each table holding business data has a non-null `tenant_id`, and
   composite foreign keys (`tenant_id`, `id`) stop a row in one business from pointing at a row in another. A test fails if a
   table appears that is not classified as tenant-scoped or global, or if a tenant table lacks the column.
2. **PostgreSQL row-level security**, forced, on every tenant table. The API connects as a role that is not the table owner and
   cannot bypass policies. With no business set, every tenant table returns zero rows and rejects writes. The only widenings
   are deliberate and narrow: a person may _read_ the businesses they have a membership in (to list their workspaces); writes are
   always confined to the current business. The one cross-tenant read, the worker re-queuing imports that were saved but never
   queued (`import_sweep`), is **not a policy**: it is the `SECURITY DEFINER` function `stale_pending_imports(seconds, max)`,
   which can only return `(id, tenant_id)` of old `PENDING` imports and is executable by the app role alone. The function runs as
   the table owner, which therefore has one `SELECT` policy of its own (`sweep_owner_select`, `TO` the owner role: it matches no one
   else and no session setting switches it on); the app role stays fully confined, and the `imports-sweep` test asserts no other
   row or table is reachable.
3. **Every protected request is verified against the database.** The access token only names a user, a business and a
   session. On each request the guard re-reads the session (not revoked or expired), the user (not disabled) and the
   **membership and role** for that exact (user, business), then checks the route's permission. So role changes, removal and
   sign-out take effect on the next request, not at token expiry.
4. **The business is never taken from the request.** There is no tenant header, query or body field that selects the
   business. It comes from the verified session. `POST /v1/auth/switch-tenant` is the only way to change it (it starts a new
   session in the target business), and it succeeds only if a membership exists; a business that does not exist and one the caller does not belong to produce the **same**
   `403` response, so ids cannot be probed.
5. **Ids in paths are looked up inside the current business.** Asking for another business's record by its id (member,
   invitation, product, variant, location, reservation, import, category) returns `404` as if it did not exist, and a write
   changes nothing.

## Audit trail

Audit rows are appended in the same transaction as the change (so they commit or roll back together), cannot be updated or
deleted by the application role, and are readable only inside their own business (`GET /v1/audit-logs`, `audit:read`).

| Action                                                                                                                                             | When                                                                                           |
| -------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| `tenant.created`                                                                                                                                   | A business is created (sign-up, or `POST /v1/workspaces`; the latter records where from).      |
| `tenant.updated`                                                                                                                                   | Profile or regional settings changed. Records **which fields** changed, not their values.      |
| `member.invited` / `member.invitation_revoked`                                                                                                     | An invitation is sent or revoked.                                                              |
| `member.joined`                                                                                                                                    | An invitation is accepted.                                                                     |
| `member.role_changed` / `member.removed`                                                                                                           | A role is changed or a member is removed.                                                      |
| `auth.switch_tenant`                                                                                                                               | A person enters a business (logged in the business entered).                                   |
| `auth.register`, `auth.login`, `auth.login_failed`, `auth.logout`, `auth.token_reuse_detected`                                                     | Session events.                                                                                |
| `order.created`, `order.updated`, `order.status_changed`, `order.cancelled`, `order.bulk_status`, `orders.imported`, `export.orders`, `customer.*` | Orders and customers (names, phones and addresses are never logged).                           |
| `courier.connection_saved`, `courier.connection_removed`, `courier.connection_tested`, `shipment.*`                                                | Courier connections (which fields changed, never values) and shipment steps.                   |
| `settlement.*`, `finance.*`                                                                                                                        | Statement imports and every manual financial decision (with the reason in the line's history). |
| `category.*`, `product.created`, `variant.created`, `location.*`, `import.queued`                                                                  | Catalog administration.                                                                        |
| `automation.rule_changed`                                                                                                                          | A rule was switched on or off or changed. Records **which fields** changed, not their values.  |
| `messaging.consent_granted` / `messaging.consent_revoked`                                                                                          | A member agreed to or stopped SMS/WhatsApp messages (the channel, never the number).           |

## What proves it

- `apps/api/test/tenant-isolation.e2e.test.ts`: database-level isolation (fail closed, only own rows, append-only audit, every
  table classified and forced), plus cross-tenant API reads and writes for members, catalog and inventory.
- `apps/api/test/workspaces.e2e.test.ts`: the workspace list shows only the caller's businesses; switching into a stranger's or
  a missing business gives identical `403`s; a client-supplied business id is ignored or rejected; settings writes land only in
  the caller's business; manager, staff and accountant are refused `PATCH /v1/tenant`; a role change or removal applies on the
  very next request; another business's members and invitations cannot be read, changed or deleted by id; the row-level
  policy exposes only the caller's own businesses.
- `apps/api/test/members.e2e.test.ts`: the permission matrix on every protected route, and the owner/admin assignment rules.
- `apps/web/e2e/workspaces.spec.ts`: creating, editing, switching and read-only settings through the real web app.
