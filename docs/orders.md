# Orders and customers

How an order is made, how it moves, exactly when stock is held and let go, and what keeps all of that correct when two people
(or two retries) act at once. Endpoints are listed in [api.md](api.md) and `docs/openapi.json`; the inventory side is in
[inventory.md](inventory.md); who may do what is in [permissions.md](permissions.md).

Everything is scoped to the signed-in business, like the rest of the product: an order, customer, address or item id from
another business is `404` (or `400` when used inside a request), never a leak and never a change.

## Customers and addresses

- A **customer** is identified by a Bangladeshi mobile number, kept in one canonical form (`+8801XXXXXXXXX`). `01712-345678`,
  `+88 01712 345678`, `8801712345678`, `1712345678` and Bangla digits (`০১৭১২৩৪৫৬৭৮`) are all the same customer. Taking an order for a
  number already on file reuses that customer (one SQL statement, so two orders for a new number at once still make one
  customer); an existing customer is never renamed by an order.
- A customer has up to 20 saved **addresses** (recipient, phone, address line, thana/upazila, district, division, postal code).
  The first is the default; exactly one is default at a time; removing the default promotes the oldest remaining one.
- **An order keeps its own copy of the delivery address**, taken when it was made. Editing or deleting an address in the address
  book never rewrites an order that already exists.
- **Order history** (`GET /v1/customers/{id}/orders`) lists a customer's orders newest first, with plain counts: orders,
  delivered, cancelled, returned, and the value of delivered orders.
- **No automatic judgement.** There is no score, rating, flag, blacklist or "risky" label anywhere: not in the API, the screens,
  or the database. The counts are for a person to read. Nothing blocks a customer from ordering because of past returns or
  cancellations. Tests assert the customer payload contains no such fields.

## The status machine

Names follow the product brief. The architecture's `DRAFT`, `PACKED` and `HANDED_OVER` are the same steps as
`pending_confirmation`, `ready_to_ship` and `shipped`; `delivery_failed`, `return_requested` and `returned` were added because a
cash-on-delivery business has to track failed deliveries and returns explicitly. (Partial delivery and exchange from the
architecture are not built.)

```
pending_confirmation ──► confirmed ──► ready_to_ship ──► shipped ──► in_transit ──► delivered ──► return_requested ──► returned
        │                    │               │               │            │             ▲                 │
        ▼                    ▼               ▼               ▼            ▼             │                 ▼
    cancelled            cancelled       cancelled      delivered    delivery_failed ───┘ (retry)       delivered (return declined)
                                                        delivery_failed   │
                                                                          └──► return_requested
```

| From                    | May become                                        |
| ----------------------- | ------------------------------------------------- |
| `pending_confirmation`  | `confirmed`, `cancelled`                          |
| `confirmed`             | `ready_to_ship`, `cancelled`                      |
| `ready_to_ship`         | `shipped`, `cancelled`                            |
| `shipped`               | `in_transit`, `delivered`, `delivery_failed`      |
| `in_transit`            | `delivered`, `delivery_failed`                    |
| `delivery_failed`       | `in_transit` (retry), `return_requested`          |
| `delivered`             | `return_requested`                                |
| `return_requested`      | `returned`, `delivered` (the return was declined) |
| `returned`, `cancelled` | nothing (final)                                   |

A shipped order cannot be cancelled: the goods have left. A move the table does not list is `409 invalid_transition`, and
changes nothing. The same table drives the API, the buttons on the order page (only legal moves are offered) and the
property tests. A reason (3 to 300 characters) is required for `cancelled`, `delivery_failed`, `return_requested` and
`returned`, and is kept in the history.

Until couriers are integrated (a later milestone), a person moves orders through `shipped`, `in_transit`, `delivered` and
`delivery_failed` by hand. The courier integration will drive the same transitions through the same code.

## Exactly when stock moves

| Transition                                | Effect on stock                                                                                                             |
| ----------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| creating an order (or importing one)      | **Nothing.** An unconfirmed order holds no stock, so chat enquiries cannot lock up the shelf.                               |
| `pending_confirmation` → `confirmed`      | **Reserve** every line, all or none. If anything is short, nothing is reserved and the error names every short SKU.         |
| `confirmed`/`ready_to_ship` → `cancelled` | **Release** the reserved units; they are available again at once.                                                           |
| `pending_confirmation` → `cancelled`      | Nothing (nothing was held).                                                                                                 |
| `ready_to_ship` → `shipped`               | **Ship**: the reserved units leave (`SHIP` ledger entries). Delivery later moves nothing.                                   |
| `return_requested` → `returned`           | **Restock**: each line returns to the shelf, or to the damaged bucket if marked damaged. Asking for a return moves nothing. |
| everything else                           | Nothing.                                                                                                                    |

`Create and confirm` does the first two in one database transaction: if stock is short there is no order, no customer and no
order number used.

Every movement is an ordinary ledger entry (so it shows on the Stock page with its reason) tagged `referenceType: "order"` and
the order's id. Reserve, release, ship and return each carry an idempotency key built from the order and the line
(`reserve:<order>:<line>`, `release:...`, `ship:...`, `return:...`), unique per business in the ledger.

### Why it cannot oversell or double-adjust

- **Reserving** uses the same single conditional `UPDATE ... WHERE on_hand - reserved >= quantity` as the rest of the system.
  Thirty orders confirming at once for ten units give exactly ten confirmations and twenty `409 insufficient_stock`.
- **Order of locking.** Lines are reserved in a fixed order (by variant), so two multi-item orders cannot lock each other's
  stock in opposite directions and deadlock.
- **One status change at a time per order.** Every status change first locks the order row (`SELECT ... FOR UPDATE`) and reads
  the current status under that lock. Twelve simultaneous cancels of one order release the stock once.
- **Repeating is harmless.** Asking for the status an order is already in returns it unchanged, writes no history row and moves
  no stock. This is what makes cancel and return idempotent. If an effect were ever applied twice anyway, its idempotency key
  would hit the unique index and roll the whole change back.
- Tests: confirm races for the last unit; 30 orders for 10 units; 12 concurrent cancels; 8 concurrent returns; bulk cancels
  repeated; and a randomised test that applies random creations and status changes through the API and checks every response
  and the final stock against the pure domain rules, including that nothing is ever created or lost.

## Totals are the server's

`line total = quantity × unit price − line discount`; `subtotal = Σ line totals`; `total = subtotal − discount + delivery charge`;
`cash on delivery = total − advance paid`. All in whole paisa (no floats), by one pure function
(`calculateOrderTotals` in `packages/domain`) that the API, the CSV import and the web/mobile preview all use.

- A request that carries a `totalMinor`, `subtotalMinor`, `codAmountMinor` or `lineTotalMinor` is **refused** (400), not quietly
  ignored. Clients send quantities, optional prices and discounts, and three adjustments; they receive every derived figure.
- A line's price defaults to the variant's current catalog price and is **recorded on the line**; a negotiated price may be
  sent. Changing the catalog later never rewrites an order.
- Limits: 1 to 100 lines, quantity 1 to 10,000, any amount up to ৳20,000,000, discounts no larger than what they discount,
  advance no larger than the total. Each refusal names the field (`lines.1.quantity`, `advancePaidMinor`).
- The database repeats the arithmetic as `CHECK` constraints (`total = subtotal − discount + delivery`, `cod = total − advance`,
  `line total = quantity × price − discount`), so even a bug in the application cannot store figures that do not add up. A test
  tries to and is refused.
- The form shows a live **estimate** using the same function, labelled as an estimate; after saving, the page shows only the
  server's figures.

## Creating an order exactly once

- `idempotencyKey` is **required** on `POST /v1/orders` (8 to 100 characters). The web and mobile forms make one per form, so
  pressing Create twice, or retrying after a dropped connection, is the same request.
- Same key and same content returns the order already made (`201`, same id and number) and holds stock once, even with twenty
  simultaneous requests (one wins the unique index, the rest find it). Same key with different content is
  `409 idempotency_conflict` and changes nothing. Keys are per business.
- The architecture sketched an `Idempotency-Key` header; the registry models bodies, not headers, and the stock endpoints already
  use a body field, so orders follow that for consistency.
- Order numbers are per business, from 1001, ascending and gap-free: a counter row locked inside the order's own transaction,
  so a failed or rolled-back order gives its number back.

## Possible duplicate orders

`POST /v1/orders/duplicate-check` and `GET /v1/orders/{id}/duplicates` list recent (72 hours), non-cancelled orders for the same
phone number that either were placed in the last ten minutes (a double submit with a different key) or share an item with the
new order, each with plain reasons. The order form shows this before you save, and the order page shows it afterwards. It is a
hint: it never blocks an order and says nothing about the customer. Another business's orders are never considered.

## Editing

| Status                                                                      | What can change                                                                                                  |
| --------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `pending_confirmation`                                                      | Everything: items, prices, discounts, delivery, advance, address, source, notes (totals re-worked by the server) |
| `confirmed`, `ready_to_ship`                                                | Address, source and notes. **Items and amounts are frozen** because stock is held against them.                  |
| `shipped`, `in_transit`, `delivered`, `delivery_failed`, `return_requested` | Notes only                                                                                                       |
| `cancelled`, `returned`                                                     | Nothing                                                                                                          |

Every order has a `version`. Sending the version you saw (`ifVersion`) turns a lost update into `409 version_conflict`.

## Finding orders

`GET /v1/orders` takes `q` (order number or `#number`, customer or recipient name, phone fragment in any form, SKU, product
name), `status` and `source` (comma-separated lists), `customerId`, `from` and `to` (dates in the **business's own time
zone**), `minTotalMinor`, `maxTotalMinor`, `sort` (`createdAt`, `orderNumber`, `totalMinor`, `status`) with `dir`, `limit`
(1 to 100) and `cursor`. Paging is keyset-based on (sort column, id), so it is stable while orders are being created, and
`total` is the count of everything that matches. `%` and `_` in a search are ordinary characters. The same filters drive the
CSV export.

## Bulk actions

`POST /v1/orders/bulk-status` moves up to 100 orders to one status. **Each order is its own transaction**: the result lists, per
order, whether it moved and why not (`insufficient_stock`, `invalid_transition`, `not_found`), and one failure never undoes or
blocks the others. Repeating a bulk cancel changes nothing the second time. An order id from another business is simply a
`not_found` row. The action is audited once with the counts.

## CSV

**Import.** One row per order line; rows sharing an `order_ref` are one order. Required: `order_ref`, `customer_name`, `phone`,
`address_line`, `area`, `district`, `division`, `sku`, `quantity`. Optional: `recipient_name`, `postal_code`, `unit_price`,
`line_discount`, `discount`, `delivery_charge`, `advance_paid`, `source`, `source_reference`, `notes`. There is no total column
(unknown columns are rejected): totals are worked out from quantities and prices.

- **Check first.** `POST /v1/imports/orders/validate` returns how many orders, what they would total, and every problem row
  (bad phone, unknown or archived SKU, contradictory customer details within an order, a discount larger than the order...). It
  creates nothing. The screen only offers the import after a check of the exact text.
- **Apply.** `POST /v1/imports/orders` creates the good orders as `pending_confirmation` (an import never reserves stock). An
  order with any bad line is left out whole, so half an order is never created. Each order has its own transaction and its own
  idempotency key derived from the file's hash and the `order_ref`: **uploading the same file twice creates nothing the second
  time.** (An edited file is a different file; the duplicate hint is there for that.)
- Limits: 2 MB, 5,000 rows, 500 orders per file.

**Export.** `GET /v1/exports/orders` (same filters as the list) returns one row per order line with the order's figures repeated,
in plain decimals; phone numbers are written locally (`01712345678`) and formula-looking text is neutralised. It is audited and
never contains another business's orders.

## History and audit

- **Status history** (`order_status_history`) gets a row for the order's creation and for every status it enters: from, to,
  reason, who, when. The application's database role can add to and read it, and **cannot update, delete or truncate it** (a test
  tries each). It is read in time order with ties broken by time-ordered ids.
- **Audit log** entries: `order.created`, `order.updated`, `order.status_changed`, `order.cancelled`, `order.bulk_status`,
  `orders.imported`, `export.orders`, `customer.created`, `customer.updated`, `customer.address_added`,
  `customer.address_updated`, `customer.address_removed`. They record field names and counts, **never** phone numbers, names or
  addresses (a test checks).

## Screens

| Screen                   | Web | Mobile | Notes                                                                                    |
| ------------------------ | :-: | :----: | ---------------------------------------------------------------------------------------- |
| Orders list              | yes |  yes   | Search, status/source/date filters, sort, paging, select, bulk actions, CSV export       |
| New order, edit order    | yes |  yes   | Customer lookup by phone, saved addresses, catalog search, live estimate, repeat warning |
| Order page               | yes |  yes   | Server totals, status history, only the legal next steps, possible repeats               |
| Customers, customer page | yes |  yes   | Search, addresses, plain counts, order history                                           |
| Import orders            | yes | yes\*  | \*Paste-based; the mobile app has no file picker yet                                     |

All screens read and write through the real API; there are no sample orders anywhere. Web and mobile render the same screens
from `packages/features`.

## Tests

- `packages/domain`: the state machine (every pair), the stock effect of every transition and a walk of every legal path,
  totals (including a 500-run property that the figures always add up exactly), phone numbers in every spelling, CSV parsing.
- `apps/api/test/orders.e2e.test.ts` and `orders-more.e2e.test.ts`: totals and refusals, numbering, idempotent creation (20
  concurrent), every illegal transition, reservation all-or-nothing, concurrent confirms, cancellation and return idempotence,
  editing rules, database constraints, append-only history, audit contents, search/filter/sort/paging in every order, customers
  and addresses, duplicates, bulk, import/export, **tenant isolation** (read, write and attach by id, row-level policies), roles,
  and a randomised test of orders against stock.
- `packages/features`: the order screens rendered over a fake API (the same screens the mobile app mounts).
- `apps/web/e2e/orders.spec.ts`: whole flows in a real browser, accessibility and phone width.
- `apps/mobile`: every order and customer route exists.

## Limits

No courier, shipment or tracking yet; no partial delivery, exchange or partial return (a return restocks the whole order, with a
condition per line); no payments beyond the advance and the COD amount (COD reconciliation is the next phase); no per-item
reservation location choice (the default location is used); order import is synchronous and capped at 500 orders; bulk
actions are capped at 100; the mobile app has no file picker for CSV import.
