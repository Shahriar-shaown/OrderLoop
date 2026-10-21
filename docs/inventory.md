# Products and inventory

How products, suppliers, stock and CSV import/export work, and the contract the orders and returns workflows (a later
milestone) must follow so inventory never changes twice or without a reason. Endpoint details are in [api.md](api.md); the
tables are in [database.md](database.md); who may do what is in [permissions.md](permissions.md).

Everything here is **scoped to the signed-in business**: reads and writes can only reach that business's rows (row-level
security plus an explicit tenant filter in every query), and an id from another business is `404`/`400`, never a leak.

## What a business can record

| Thing    | Fields                                                                                                                                  |
| -------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| Product  | name, description, category, supplier, up to 8 picture links (`https://`), unit (`pcs`, `kg`, ...), active or archived                  |
| Variant  | SKU (immutable, unique per business), name, **size** and **colour** (attributes), selling price, cost price, barcode, reorder threshold |
| Supplier | name, contact person, phone, email, address, notes, archived or not                                                                     |
| Stock    | per variant and location: `onHand`, `reserved`, `damaged`; `available = onHand - reserved`                                              |

Pictures are **links**, not uploads (there is no file storage yet). The reorder threshold drives low-stock alerts
(`GET /v1/inventory/low-stock`, the Low stock tab, and the highlighted "low" badges).

## Money

Money is **whole paisa** end to end (1 BDT = 100 paisa); there is no floating point anywhere on the path.

- The API accepts and returns integers (`"priceMinor": 125050`) and refuses fractions, negatives and amounts above
  2,000,000,000 paisa.
- Forms and CSV files use decimal text (`1250.50`). It is converted with string arithmetic (`bdtToPaisa`), at most two
  decimals, so `0.1 + 0.2` style errors cannot occur, and `12.345` is a validation error rather than a silent rounding.
- Exports turn paisa back into decimal text the same way (`paisaToBdtString`). A test imports and exports `1250.50` and
  `700.00` and checks the exact text.

## Stock: three buckets and a ledger

Stock is never edited directly. Each change is **one conditional SQL statement on `stock_levels` plus one appended
`stock_movements` row, in one transaction** (`packages/catalog/src/stock.ts`). The level is always the running total of the
ledger; a randomised test (sequential and concurrent) replays the ledger through the pure rules and checks it lands on the
stored level, including damaged units.

| Movement     | `onHand` | `reserved` | `damaged` | Request                              | Needs                            |
| ------------ | :------: | :--------: | :-------: | ------------------------------------ | -------------------------------- |
| `RECEIVE`    |    +     |            |           | `POST /v1/inventory/receive`         | quantity                         |
| `ADJUSTMENT` |   +/-    |            |           | `POST /v1/inventory/adjust`          | **reason**                       |
| `RESERVE`    |          |     +      |           | `POST /v1/reservations`              | quantity                         |
| `RELEASE`    |          |     -      |           | `POST /v1/reservations/{id}/release` | an active reservation            |
| `SHIP`       |    -     |     -      |           | `POST /v1/reservations/{id}/fulfil`  | an active reservation            |
| `DAMAGE`     |    -     |            |     +     | `POST /v1/inventory/damage`          | **reason**, only available units |
| `WRITE_OFF`  |          |            |     -     | `POST /v1/inventory/write-off`       | **reason**, only damaged units   |
| `RETURN`     |  +, or   |            |     +     | `POST /v1/inventory/return`          | **idempotency key**, condition   |

There is no way to change a quantity without a ledger row, and the runtime database role cannot update or delete ledger rows.
Rows carry who did it, the reason, and an optional `referenceType`/`referenceId` pointing at what caused it (an order, a
return, an import).

### No overselling

A reservation, an adjustment down, and marking units damaged all succeed only if `onHand - reserved >= quantity`, decided
**inside the single `UPDATE ... WHERE` statement**, atomically under the row lock. N simultaneous requests for the last units
grant exactly as many as exist and refuse the rest with `409 insufficient_stock`; a refused request changes nothing and writes
no ledger row. `CHECK` constraints (`reserved <= on_hand`, no negatives) are a second barrier. Tests: 50 parallel
reservations against 10 units; parallel adjustments racing reservations; **parallel damage racing reservations** (nothing is
created or lost, promised units stay covered); randomised bursts mixing every operation.

Damaged units sit outside `onHand`, so they are never available, never reservable, and do not count towards low-stock maths.

## The contract for orders, cancellations and returns

The orders milestone must use these operations and nothing else to touch stock. Each is safe to repeat.

| Workflow step                   | Call                                                                                                                                        | What makes a repeat safe                                                                                                                                                                                           |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Order placed: hold stock        | `POST /v1/reservations` with `referenceType: "order"`, `referenceId: <order id>` and `idempotencyKey: "reserve:<order id>:<variant id>"`    | The same key returns the original reservation and holds the units once, even if retries race.                                                                                                                      |
| Order cancelled before shipping | `POST /v1/reservations/{id}/release`                                                                                                        | A reservation resolves **exactly once** (compare-and-set on its status). A second release, or a late fulfil, is `409`.                                                                                             |
| Order shipped                   | `POST /v1/reservations/{id}/fulfil`                                                                                                         | Same single resolution: shipping twice is `409`; shipping after cancelling is `409`.                                                                                                                               |
| Goods returned by the customer  | `POST /v1/inventory/return` with `idempotencyKey: "return:<return id>:<variant id>"`, `condition`, `referenceType: "return"`, `referenceId` | The key is **required** and unique per business: processing the same return again (retry, duplicate webhook) adds the units once and returns the original result. The same key with a different quantity is `409`. |
| A returned item is unsellable   | the same call with `condition: "DAMAGED"`                                                                                                   | Goes to the damaged bucket, never to available stock.                                                                                                                                                              |

A returned **order** (`POST /v1/orders/{id}/status`, `returned`) calls the same return per line, with `returnedItems` giving the
quantity and condition of each line that came back; unlisted lines return nothing (they stayed with the customer).

Rules the orders code can rely on: an idempotency key is per business; reusing it for a **different** request is `409`, never
silently ignored; failures that did not change stock (`409 insufficient_stock`, `404`) are safe to retry; a request that
succeeded is never repeated by retrying it with the same key. Cancelling after fulfilment is not a release: a shipped order
that comes back is a **return**.

## One location in practice (pilot)

Orders reserve, ship and take returns at the **default location** only; transfers between locations are not built. The stock
screens sum all locations, so a second location can show units that confirm cannot reserve. When confirm finds the default
short and another location holding enough, it answers `409 insufficient_stock` naming each location and the default one:
receive or adjust the stock into the default location, then confirm again. For the pilot, keep one location.

## Checking the ledger

`pnpm inventory:verify` replays every stock movement per (business, variant, location) with the same pure rules the database
enforces (`replay` in `packages/domain/src/stock.ts`) and compares the result with `stock_levels`. It is read only, prints one
`DRIFT` line per level that differs (or whose ledger breaks a rule, or that has movements but no row) and exits 1 on any drift
(2 if `DATABASE_ADMIN_URL` is missing). It reads every business at once, so it connects with `DATABASE_ADMIN_URL`, not the
app's role. Test: `apps/api/test/inventory-ledger.e2e.test.ts`.

## CSV import

Paste a catalog CSV on the Import screen (or call the API). The screen **checks the file first** and shows, before anything
changes: how many rows would be created or updated, and every problem row with its line number and reason (bad price such as
`12.345`, missing SKU, unknown unit, repeated SKU, an archived product, a SKU that belongs to another product, a unit that
conflicts with the existing product, an archived supplier or location). Nothing is applied until the person presses the import
button, which says exactly what it will do ("Import 2 fine rows, skip 1"); editing the text discards the check. Files that cannot
be read at all (unknown or missing column, unterminated quote, too large) are refused with the reason.

Columns: `product_name`, `sku`, `price` (required); `category`, `unit`, `variant_name`, `size`, `colour` (or `color`), `cost`,
`reorder_point`, `barcode`, `description`, `supplier`, `opening_stock`, `location`. Unknown columns are rejected so a typo cannot
silently drop data. Limits: 2 MB, 5,000 rows. Applying runs in the background worker, one transaction per row, so a bad row never
loses the good ones; re-importing is idempotent (existing SKUs update, opening stock is only for new variants).

## CSV export

`GET /v1/exports/products` writes the active catalog in exactly the import columns: edit it and import it back (the tests
export, validate the result, and expect zero problems and every row "update"). `GET /v1/exports/stock` writes one row per variant
and location with on hand, reserved, damaged, available and the reorder point. Formula-looking text is neutralised, archived items
are left out, and each export is recorded in the audit log.

## Screens

| Screen (web)                                   | Mobile   | Notes                                                                                                        |
| ---------------------------------------------- | -------- | ------------------------------------------------------------------------------------------------------------ |
| Products list, search                          | yes      | Search by name or SKU, active / archived filter.                                                             |
| New product, edit product                      | yes      | Description, category, supplier, picture links, variants with size, colour, price, cost, threshold.          |
| Product page                                   | yes      | Variants with on hand / reserved / available / damaged; receive, adjust, reserve, damage, write off, return. |
| Stock                                          | yes      | Levels (with damaged), low stock, movement ledger, reservations; stock CSV export.                           |
| Suppliers                                      | yes      | Create, edit, archive.                                                                                       |
| Categories, Locations                          | web only | Small admin screens; not built for mobile yet.                                                               |
| Import (check, then apply), catalog CSV export | web only | The mobile app has no file picker yet. The stock CSV export is available on mobile through the share sheet.  |

Web and mobile render the same screens from `packages/features` (see [web.md](web.md)).

## Tests

- `apps/api/test/inventory-module.e2e.test.ts`: product fields, suppliers (including cross-business), damage/write-off/return,
  idempotent returns and cancellations, exports, import preview.
- `apps/api/test/inventory.e2e.test.ts`: concurrency and the ledger-replay property tests, now including damaged stock.
- `apps/api/test/imports.e2e.test.ts`: the real worker, including size, colour and supplier columns.
- `apps/api/test/tenant-isolation.e2e.test.ts`: every tenant table (now including `suppliers`) is classified, has forced
  row-level security, and cannot be read or written across businesses.
- `packages/domain`: the pure stock model with damaged units, money, CSV parsing and writing, import parsing.
- `packages/features`: the stock screens, dialogs and product page rendered over a fake API (the same screens the mobile app mounts).
- `apps/web/e2e/inventory.spec.ts` and `catalog.spec.ts`: the whole flows in a real browser.
- `apps/mobile`: route coverage and device-storage wiring.

## Limits

No purchase orders or receiving against a supplier yet (a supplier is a label on a product); no transfers between locations;
pictures are links; no barcode scanning; the mobile app cannot import files or edit categories and locations; per-location
export for very large catalogs is capped at 50,000 rows.
