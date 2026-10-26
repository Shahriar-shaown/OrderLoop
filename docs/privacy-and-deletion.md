# Privacy and deletion

What OrderLoop can delete, anonymise and keep, how a person asks for it, and what it cannot do. These are **technical
capabilities of the product, not a compliance statement**: nothing here says that a particular law is met, and whether
a deletion is _required_ or _allowed_ in a given case (retention of financial records, for example) is a decision for the
operator and its advisers. The operator's runbook for a request is
[operations/incident-response.md](operations/incident-response.md#data-deletion-request).

Three features, each a separate request, plus a CSV export so a business can take its data first:

| Feature               | Who may                                      | What it does, in one line                                                                                                              |
| --------------------- | -------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| **Erase a customer**  | `customers:erase` (OWNER, ADMIN)             | Irreversibly removes one customer's personal data, here and on their orders. Totals, statuses and dates stay.                          |
| **Delete my account** | the person themselves (password asked)       | Removes the person's sign-in and personal data; the row stays, anonymised. A business they alone belong to is scheduled for deletion.  |
| **Delete a business** | `tenant:delete` (OWNER only; name, password) | Blocks the business at once, deletes courier, Meta and TikTok Shop credentials, and after a grace period the worker deletes every row. |
| **Export**            | `orders:read` etc.                           | `GET /v1/exports/customers`, `/orders`, `/products`, `/stock` as CSV.                                                                  |

Screens: _Customers > a customer > Erase personal data_; _account menu > Your account > Delete my account_; _Settings >
Delete this business_ (owners); the blocking screen a business shows while it is scheduled. The same screens exist on web and
mobile (they are shared code). A public page, `/data-deletion` on the web app, explains the steps to anyone without signing in;
it is the "Data deletion instructions URL" for Meta ([meta.md](meta.md)).

## Why the work is done in the database

Orders, shipment events, settlement events, the stock ledger, status history and the audit log are **append-only for the
application role (`app_user`) by design**: it has no `UPDATE` or `DELETE` on them, so a bug in the API cannot rewrite history. Erasing
or purging therefore cannot be done with ordinary statements. Each operation is a narrow `SECURITY DEFINER` function owned by the
migration role (migration `20261031100000_data_deletion`), the same pattern as `stale_pending_imports` and `purge_social_data`:

| Function                                   | Granted to | Guard inside the function                                                                                                               |
| ------------------------------------------ | ---------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| `erase_customer(tenant, customer, reason)` | `app_user` | The transaction must already be scoped to `tenant` (`app.tenant_id`), the fence row-level security gives every query.                   |
| `delete_own_account(user)`                 | `app_user` | The transaction must be scoped to `user` (`app.user_id`) and the person must have no membership left.                                   |
| `tenants_due_for_purge(max)`               | `app_user` | Returns ids only, of businesses whose `purge_after` has passed.                                                                         |
| `purge_tenant(tenant)`                     | `app_user` | Refuses unless the business asked to be deleted **and** its grace period is over; so no value the API can pass deletes a live business. |
| `_anonymise_user`, `erasure_*` helpers     | nobody     | Called only by the functions above.                                                                                                     |

Every function pins `search_path`, and the owner has narrow owner-only policies for what it needs (an `UPDATE`/`DELETE` policy on
`stock_movements` and `audit_logs` confined to the scoped business, never to `app_user`). Tests: `apps/api/test/customer-erasure.e2e.test.ts`,
`account-deletion.e2e.test.ts`, `tenant-deletion.e2e.test.ts` (they assert the grants, the guards and that nothing outside the
scope changes).

## Erasing a customer

`POST /v1/customers/{id}/erase` `{ confirm: true, reason? }` (`customers:erase`; `409 erase_blocked` while the customer has an
order in progress, that is any status other than `delivered`, `cancelled` or `returned`; the message says how many).

| What                                                                                                                                              | Result                                                                                                                                                                                                     |
| ------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `customers`: name, phone, email, notes                                                                                                            | Name becomes `Erased customer`; phone becomes `erased-<customer id>` (so the real number can be a new customer later); email and notes cleared; `erased_at` set. The row stays because orders point at it. |
| `customer_addresses`                                                                                                                              | Deleted.                                                                                                                                                                                                   |
| `orders`: ship name, phone, address line, area, postal code, notes, source reference                                                              | Replaced by placeholders or cleared. **District and division are kept** (coarse; delivery statistics use them). Totals, status, ids and dates are untouched.                                               |
| `order_status_history.reason`, `stock_movements.reason`, cost notes, discrepancy text, notifications, failed CSV imports                          | The customer's exact name, phone spellings, email and address lines are replaced by `[erased]` **anywhere in the business** (see limits).                                                                  |
| `shipment_events.payload`, `settlement_items.raw`/`phone`/`note`, `settlement_item_events.data` for this customer's shipments and statement lines | Values under keys that name a person (name, phone, address, recipient, customer, email, contact, note) are replaced; the phone column is cleared. Amounts, dates and ids stay, so finance still adds up.   |
| Meta: `social_drafts` of their orders or quoting their number, and the `social_events` of those conversations                                     | Deleted.                                                                                                                                                                                                   |
| `idempotency_keys` whose stored answer holds their details                                                                                        | Deleted (they only exist to replay a retry).                                                                                                                                                               |
| `audit_logs`                                                                                                                                      | Never held names, phones or addresses (ids and counts only). One `customer.erased` entry is added, with counts and the reason you gave **with the customer's own name and number taken out**.              |

Repeating the call returns the same answer and writes nothing more. An erased customer cannot be edited, given an address or
used on a new order (`409`, or `400` on an order). `Customer.erasedAt` tells screens; the customer export leaves them out.

**What this cannot do.** Only exact spellings are found in free text: a nickname, a misspelling, a number with spaces in it, or a
different person's details typed into a note are not. Names shorter than four characters are not scrubbed from free text (they
would match too much), though the structured fields are always replaced. Orders keep what they are by design: product lines,
amounts, dates and statuses. Couriers (Pathao, Steadfast), Meta, and any parcel label or SMS already sent keep their own
copies, which OrderLoop cannot remove: ask them. Backups keep the data until they expire (below).

## Deleting an account

`POST /v1/me/delete` `{ password, confirm: "DELETE" }`. A wrong password is `401 invalid_credentials`, the same answer and the
same lockout counters as signing in (and is rate limited). The person's own current business may be scheduled for deletion; the
route still works then.

- **Refused** with `409 account_delete_blocked` (the businesses are listed in `errors[]` with path `businesses`) when the
  person is the only OWNER of a business that has other members: make someone else an owner, or remove the members, first. Nothing
  changes when it is refused.
- A business the person is **the only member of** goes through business deletion in the same request (grace period below). The
  response lists them: `businessesScheduled: [{ id, name, purgeAfter }]`. Nobody is left to cancel those.
- Removed: all sessions and refresh tokens, one-time tokens, push devices, notification settings and notifications for that
  person, SMS/WhatsApp consent, every membership, the IP address on the audit rows their actions left (all businesses), user-scoped
  idempotency keys. Pending invitations they sent are revoked.
- Kept: the `users` row, so that orders, the stock ledger and audit rows still point at an id. It becomes
  `deleted-<id>@deleted.invalid`, name `Deleted user`, empty password hash, `disabled_at` and `deleted_at` set. The email address
  is free to register again as a new account.
- An email goes to the **old** address after the commit (no link, no token). Audit: `account.deleted` in each business the person
  belonged to.

## Deleting a business

1. **Ask.** `POST /v1/tenant/delete-request` `{ confirmName, password }` (`tenant:delete`, OWNER). `confirmName` must equal the
   business name. The grace period is `TENANT_DELETION_GRACE_DAYS` (default 14, at least 1). Sets `deletion_requested_at`,
   `purge_after`, `deletion_requested_by_id` on the tenant.
2. **At once:** every route except the few below answers `403 tenant_deleted` (checked before the role, for everyone). Courier
   credentials and webhook secrets are deleted and the connections disabled; TikTok Shop tokens are deleted and the shops disconnected;
   Meta tokens are deleted and the connections
   disconnected (the Page's subscription at Meta is **not** removed: events for a disconnected account are ignored); automation
   rules are switched off; pending invitations are revoked; every session scoped to the business is revoked **except the owner's
   own** (so they can reach Cancel); every member is emailed the date. Nothing is deleted from the business's data yet.
3. **Still answered while blocked:** `GET /v1/tenant/deletion-status` (any member), `POST /v1/tenant/cancel-deletion` (owner),
   `GET /v1/me`, `GET /v1/workspaces`, `POST /v1/workspaces`, `POST /v1/auth/switch-tenant`, `POST /v1/auth/logout`, `POST /v1/me/delete`.
   The web and mobile apps replace the whole business with a screen showing the date, **Cancel deletion** for the owner, and
   Switch business / Sign out for everyone.
4. **Cancel.** `POST /v1/tenant/cancel-deletion` within the grace period. The business works again, but what was deleted in step 2
   is **not restored**: reconnect couriers, Meta and TikTok shops, switch rules on again. After `purge_after` it is `409` even if the worker has not
   run yet.
5. **Purge.** The worker's hourly job `tenant-purge` (BullMQ scheduler, fixed id, queue `tenant-purge`) asks `tenants_due_for_purge`
   and calls `purge_tenant` for each. The function re-checks the conditions, locks the tenant row, deletes every table's rows
   children first (the order is in the migration; a test fills **every** table in `TENANT_TABLES` and asserts zero rows afterwards), the
   business's sessions and its create-business idempotency answer, then the tenant row, and writes one tenant-less audit line
   `tenant.purged` (row count only). It logs `tenant.purged` with per-table counts, ids only. Repeating it, or two workers racing, is
   harmless (`purged: false`).
6. **The person who asked.** If, after the purge, they belong to no business at all, their account is anonymised like a deleted
   account (otherwise they would be left unable to sign in). A member who only belonged is **not** touched: they keep their
   account, and are invited or accepted into another business as usual; a person with no business cannot sign in until then.

Running a purge by hand (for an operator who must not wait for the hourly job): set up the same call the worker makes, with the
runtime credentials, after checking `deletion_requested_at` and `purge_after`:

```sql
-- as the application role (DATABASE_URL); nothing else is needed or allowed
SELECT * FROM tenants_due_for_purge(20);            -- which businesses are due
SELECT * FROM purge_tenant('<tenant id>'::uuid);   -- deletes one, refuses if not due
```

To bring a purge forward on a business that asked and is waiting, an operator with the owner/admin database role may
`UPDATE tenants SET purge_after = now() WHERE id = ...` first; it is the only way, by design, since no API call can shorten the
grace period. Do it only on the owner's written request, after the export.

## TikTok Shop data

[tiktok-shop.md](tiktok-shop.md) has the full list. In short: a connected TikTok shop is mirrored **without any buyer personal data**
(no name, phone, email, address, message or buyer id; only TikTok's order id, status, timestamps, SKU lines, amounts in the shop's currency,
the shop's region and the fulfilment type), so there is **nothing to erase for a customer** and TikTok orders are not OrderLoop customers.
What does exist and how it goes:

| What                                                  | Where                                 | How it goes                                                                                                                                                             |
| ----------------------------------------------------- | ------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Sealed access and refresh tokens, the shop cipher     | `tiktok_connections`                  | Deleted when the shop is disconnected, and for every shop when the business is scheduled for deletion.                                                                  |
| A sealed token pair in a sign-in hand-over            | `tiktok_oauth_sessions`               | Deleted when the shops are chosen, a day after it expires by the worker's retention, and at once when the business is scheduled for deletion.                           |
| Webhook events (ids and a status word)                | `tiktok_events`                       | Deleted after 30 days by the worker (`purge_tiktok_data`); with the business at the purge.                                                                              |
| Mirrored orders, their lines and stock holds          | `tiktok_orders`, `tiktok_stock_holds` | Deleted `TIKTOK_RETENTION_DAYS` (default 180, at least 30) after the last change when in a final state and holding no live reservation; with the business at the purge. |
| SKU links                                             | `tiktok_sku_links`                    | Kept while the business exists (they are the seller's own mapping); deleted with the business.                                                                          |
| Stock ledger lines (`TikTok order <TikTok order id>`) | `stock_movements`                     | Kept like all stock history; the reason holds a shop-side order id, no buyer data.                                                                                      |

TikTok also keeps its own copies of everything it sent: OrderLoop cannot remove them. A seller who removes the app in TikTok Shop is
handled as a deauthorisation if the `SELLER_DEAUTHORIZATION` event is subscribed (the shop is marked as needing reconnection).
TikTok's app review asks for a privacy policy URL and a description of the data handled: this section and the tiktok-shop.md list are that description.

## Taking the data first

`GET /v1/exports/customers` (new; `orders:read`, 5 per minute per business, spreadsheet-safe, audited as `export.customers`) lists
name, phone, email, notes, default address and plain order counts, leaving erased customers out. The orders, products and stock
CSVs already existed (`/v1/exports/orders`, `/products`, `/stock`). The Delete-business screen offers all four. **There is no
export of settlements, costs or the audit log**: a business that needs them must ask the operator ([known-issues.md](known-issues.md)).

## Backups, copies and retention

Deleting rows does not touch backups. A deleted customer, account or business is **still in every backup taken before the
deletion until that backup expires** (daily dumps are kept for 14 days and weekly dumps for 8 weeks in the proposed schedule,
[operations/backup-and-restore.md](operations/backup-and-restore.md#backups-contain-personal-data)); a restore brings the data back
and the pending deletions must be re-applied (erase again, or run the purge for the businesses whose `purge_after` has passed).
Logs hold ids, not names. Outside our control: **couriers** keep consignments they were sent, **Meta** keeps its own messages and
the Page's connection, and anything a customer or a business exported earlier. Tell the person that, with dates.

## What stays after each, and why

| Table group                                                                                     | Customer erased                                             | Account deleted                                    | Business purged                                                       |
| ----------------------------------------------------------------------------------------------- | ----------------------------------------------------------- | -------------------------------------------------- | --------------------------------------------------------------------- |
| `users`                                                                                         | n/a                                                         | row kept, anonymised (history refers to its id)    | owner anonymised only if left with no business                        |
| `sessions`, `refresh_tokens`, `user_tokens`, `push_devices`                                     | n/a                                                         | deleted                                            | sessions of the business deleted                                      |
| `memberships`, notifications, preferences, consents                                             | n/a                                                         | deleted (with the membership)                      | deleted                                                               |
| `customers`, `customer_addresses`                                                               | row kept as placeholder; addresses deleted                  | n/a                                                | deleted                                                               |
| `orders`, `order_items`, `order_status_history`                                                 | kept, personal copies removed                               | kept (ids only)                                    | deleted                                                               |
| `shipments`, `shipment_events`, `settlement_*`, `discrepancies`, `manual_costs`, `cod_receipts` | kept; payloads and statement lines redacted, notes scrubbed | kept (ids only)                                    | deleted                                                               |
| `stock_*`, `reservations`, catalog                                                              | kept (only free-text reasons scrubbed)                      | kept                                               | deleted                                                               |
| `tiktok_*` (TikTok Shop)                                                                        | nothing to do: no buyer data is stored                      | n/a                                                | deleted (tokens deleted at once)                                      |
| `social_*` (Meta)                                                                               | that customer's drafts and events deleted                   | n/a                                                | deleted                                                               |
| `audit_logs`                                                                                    | kept (never held personal data); one entry added            | kept; IP addresses of the person's actions removed | deleted with the business; one tenant-less `tenant.purged` line stays |
| `idempotency_keys`                                                                              | answers holding the details deleted                         | the person's own deleted                           | deleted                                                               |

Why money and history stay when only a customer is erased: a business has to be able to add up what it sold and was paid, and an
append-only ledger is what makes those figures trustworthy. Whether a given record must be kept, for how long, or may be deleted
is for the operator to decide; the product only guarantees that what it keeps no longer identifies the customer and, for a
purged business, that nothing is kept.

## How the incident-response request maps to these features

| Request                                                | Use                                                                                                                          |
| ------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------- |
| A customer of a shop asks the shop                     | The shop erases the customer (_Erase personal data_), after finishing or cancelling open orders                              |
| A customer wrote to a Page and removed the app at Meta | Automatic: the Meta data-deletion callback ([meta.md](meta.md#data-handling)); the shop may also erase                       |
| A user asks to delete their account                    | They use _Your account > Delete my account_; the operator can only point them there                                          |
| An owner asks to delete the business                   | The owner uses _Settings > Delete this business_; the worker purges after the grace period                                   |
| A request nobody in the app can make (no owner left)   | The operator, on written confirmation, sets the business up as above or runs the SQL, then keeps the output with the request |

## Environment

| Variable                      | Default     | Notes                                                                                            |
| ----------------------------- | ----------- | ------------------------------------------------------------------------------------------------ |
| `TENANT_DELETION_GRACE_DAYS`  | 14          | 1 to 365. Days between a business's deletion request and the purge. Read by the API only.        |
| `NEXT_PUBLIC_PRIVACY_CONTACT` | placeholder | Web: the address shown on `/data-deletion`. Set it to the operator's real address before launch. |

## Tests

`pnpm --filter @orderloop/api test:integration` runs the three suites above under the shared database lock; the features suite
(`packages/features/src/screens/account/deletion.test.tsx`) covers the dialogs, the blocked-business screen and Bangla; the worker
job is `apps/worker/src/tenant-purge.test.ts`; the browser flows are `apps/web/e2e/deletion.spec.ts`.
