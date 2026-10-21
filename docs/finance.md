# COD reconciliation and finance

How OrderLoop works out which cash couriers owe, which they have reported, and what the business earned. Every amount is an
**integer number of paisa** (1 BDT = 100 paisa). Text such as `1,250.50` is read digit by digit, never as a floating-point
number, and shown with Bangladeshi digit grouping (`৳1,25,050.00`). The database repeats the arithmetic as `CHECK`
constraints, so even a bug in the application cannot store a line whose net is not "collected less charges".

> **Read this first.** The statement format below is **OrderLoop's own, documented CSV**. Pathao's and Steadfast's real
> settlement exports were not available to check, and their columns will differ. To import a real statement you may need to
> rearrange its columns into this format (a spreadsheet is enough). No automatic mapping from a real export was built or
> tested. Everything below was tested with fictional statements.

## The words, and why they are never mixed

| Word                 | Means                                                                                                               | Comes from                                      |
| -------------------- | ------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------- |
| **Sales**            | Orders placed in the period and not cancelled, at their full total. Not money, not revenue.                         | Orders                                          |
| **Revenue**          | Goods (item prices less discounts) and delivery charges billed on orders that are **delivered**, dated by delivery. | Orders                                          |
| **Cash collected**   | Cash a courier's **statement says** it collected, on lines tied to an order. Not proof it reached your bank.        | Courier statements                              |
| **Outstanding COD**  | COD due on delivered courier orders, less cash statements report for them. **As of now**, not per period.           | Orders and statements (derived)                 |
| **Expenses**         | Cost of goods delivered, courier charges, costs you entered, and COD shortfalls you accepted as a loss.             | Product cost prices, statements, manual entries |
| **Estimated profit** | Revenue − expenses. An estimate that follows the records.                                                           | Derived                                         |

Each figure on the Finance screen and in `GET /v1/finance/summary` carries its **source** and a plain-words note of what it
leaves out. They are never added together except where stated.

### Delivered is not paid

An order being delivered says nothing about cash. A delivered courier order with no matching statement line stays in
**Outstanding COD** however old it is. COD is only reduced by cash a statement reports for that order.

## Estimated profit

```
estimated profit = goods revenue
                 + delivery charges billed to customers
                 − cost of goods (delivered lines: cost price × quantity)
                 − courier charges (delivery + COD fee + return + other deductions, from statements)
                 − costs you recorded by hand
                 − COD shortfalls written off
```

- **Partly returned orders.** An order marked returned is never revenue, even when only some lines came back; the units the
  customer kept are then in neither revenue nor cost of goods. The summary's caveats count such orders per period.
- **One definition, everywhere.** Revenue is goods (item prices less every discount, line and order level) plus delivery billed,
  on orders delivered in the period (`revenueMinor` in `packages/domain`, selected by `deliveredOrdersSql` in
  `apps/api/src/finance/revenue.ts`). Gross profit is that revenue less cost of goods (`grossProfitMinor`). The dashboard's
  profit card, the finance summary, and analytics (`daily`, `totalRevenueMinor`, `channels`) all use them, so the figures for
  one period agree. Only `topProducts` differ on purpose: a product's revenue is its lines' totals, before order-level
  discounts and delivery, which belong to no product (`itemRevenueMinor` is their sum).
- **A courier charge is counted once.** Delivery, return and deduction charges come from imported statements, so they can no
  longer be entered as costs by hand (the API accepts `packaging`, `advertising`, `other`). Old rows of those three kinds
  still display, can be voided, and are counted only while no statement reports courier charges for the period; as soon as
  one does, they are left out (and the summary says so) instead of being added a second time.
- **Revenue is by delivery date; courier charges and recorded costs are by the date printed on the statement or entered.** At
  the edges of a period these can fall on different sides. Courier charges are included even for parcels that were not
  delivered (a return charge is a real cost).
- **Profit is withheld** (with the reason) when any delivered line has no cost price, because the cost of goods is then
  unknown. No wrong number is shown.
- Advance payments are shown under Cash for information (what your team recorded). They are not added to revenue twice: an
  order's revenue already includes the part paid in advance, and COD is only the rest.

## Cancelled, returned, partial and fee-bearing orders

| Case                                            | Sales                           | Revenue                                     | Outstanding COD                                                                                | Cash and costs                                                                           |
| ----------------------------------------------- | ------------------------------- | ------------------------------------------- | ---------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| Cancelled                                       | **excluded** (shown separately) | none                                        | none                                                                                           | A statement line for it is flagged ("cash on a cancelled or returned order").            |
| Delivered, then return requested or returned    | counted (it was placed)         | **excluded** (revenue only while delivered) | none: nothing is due                                                                           | Return charges count as costs. Restocking is a person's decision (orders).               |
| Delivery failed                                 | counted                         | none                                        | none                                                                                           | Charges on statements are still costs.                                                   |
| Shipped / in transit                            | counted                         | none                                        | shown as **COD still with couriers** (not owed yet)                                            | Cash reported early is flagged ("cash before delivery").                                 |
| Partial remittance                              | n/a                             | n/a                                         | the unpaid part stays outstanding                                                              | A **shortfall** discrepancy is open until the rest arrives or a person accepts the loss. |
| Courier fees (delivery, COD fee, return, other) | n/a                             | n/a                                         | not deducted from COD: a fee reduces what the courier **pays out**, not what the customer paid | Expenses, from the statement line's own columns.                                         |
| Overpayment                                     | n/a                             | n/a                                         | none                                                                                           | **Overpaid** discrepancy.                                                                |

Partial **delivery** (some items delivered, some returned) is not modelled: orders have no partial state yet, so a person
decides what to record.

## What a statement line says

Columns (header row required; unknown columns are refused; amounts in taka, at most two decimals, never negative):

`transaction_id, consignment_id, tracking_code, reference, phone, date, type, collected, delivery_charge, cod_fee, return_charge, other_deduction, net, note`

- `date` is required (`YYYY-MM-DD`, or day-first `DD/MM/YYYY`). `type` is `cod` (default), `return` or `adjustment`.
- At least one of `consignment_id`, `tracking_code`, `reference` must be a **column**, and each `cod` or `return` line must fill
  one. An `adjustment` with none (a monthly fee) belongs to no parcel and is recorded as a cost.
- A `return` line carries no cash. `net` is optional: OrderLoop works out collected − charges itself, and keeps the file's
  figure beside it. If they differ, a **file does not add up** discrepancy is opened.
- **The whole file is refused if any line is wrong**, with every problem listed by line number. Nothing is skipped or
  guessed. `Check file` (dry run) shows this and the matching result without recording anything.

## Matching a line to a parcel

Only identifiers that cannot plausibly belong to something else are used, in this order of trust:

1. the courier's **consignment id**, 2. the **tracking code**, 3. our own **reference** (`OL-1001`, as sent to the courier).
   Each names one parcel. **If they name different parcels the line is "needs a person"**; it is never guessed.
2. Only when none of those is present, a **bare order number** (`1001`, `#1001`). If the file also gives a phone, it must be
   the order's recipient's, or the line needs a person. An order with more than one parcel for that courier also needs a person.

A phone number alone never matches, and **amounts are never used to match** (two parcels can cost the same). A line is
matched only against that courier's own **real** parcels (never simulated ones; the simulated courier has no settlements).

## Idempotent imports, no duplicate records

- The **same file** (its content, ignoring line endings, a BOM and trailing blanks, for the same courier) is imported once.
  Uploading it again, or twice at once, returns the original settlement with `alreadyImported: true`. The database enforces
  this (`unique (tenant, file hash)`).
- A **line** is identified by the courier's `transaction_id` together with its parcel (consignment, tracking code, reference)
  and type, because one payout id often covers many parcels; without a transaction id, by everything it says (parcel
  identifiers, type, date and every amount). The import result carries `warnings` (for example how many lines were left out
  as duplicates). A line that repeats one already recorded, in the same file or an earlier one, is
  kept but marked **duplicate** and **never counted**. A database index makes a second counted copy impossible.
  _Limitation:_ if a courier really prints two identical lines with no transaction id, the second is treated as a repeat.
  Ask the courier for a transaction id, or tell the lines apart with the `transaction_id` column.
- Manual costs (packaging, advertising, other) take an idempotency key: the same key records a cost once, and the same key for a different cost is refused.
- Financial records are **never deleted** (the application role cannot): lines are set aside, costs voided, discrepancies
  resolved. A line's history cannot be rewritten.

## Discrepancies

| Type                     | Opens when                                                                             | Closes when                                                          |
| ------------------------ | -------------------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| Shortfall (`short_paid`) | a delivered order has some, but not all, of its COD reported                           | the rest arrives, or a person **accepts the loss** (waive)           |
| Overpaid                 | more cash reported than the order's COD                                                | the figures change, or a person explains it                          |
| Cash before delivery     | cash is reported for an order not yet delivered (and not cancelled/returned)           | the order is delivered (after **Re-check**), or a person resolves it |
| Cash on a closed order   | cash is reported for a cancelled, returned or return-requested order                   | a person resolves it                                                 |
| Charge differs           | the delivery charge on a line differs from the fee the courier reported when it booked | a person resolves it                                                 |
| File does not add up     | the file's own `net` differs from collected − charges                                  | a person resolves it                                                 |

There is at most one discrepancy of each type per order or line, so the same problem is not listed twice. A discrepancy a
person closed stays closed while its figures stay the same, and **reopens if the figures change**. **Only a shortfall can be
waived** (the money did not arrive); everything else is fixed by correcting records. A waived shortfall appears in Expenses as
"COD shortfalls written off".

## Reconciling a settlement

A settlement is **reconciled** only by an explicit action, and only when **no line is unmatched or in doubt and no discrepancy
about its lines or their orders is open**. Otherwise the request is refused (`409 settlement_has_issues`) and says why. A
settlement can never be marked reconciled "in bulk" past an open problem. It stops being reconciled when a decision changes it
(an undone match) or a later statement or order change opens a problem for it. Duplicates are recorded and counted separately;
they have no effect and do not block reconciliation.

## Manual decisions and permissions

| Action                                                                                         | Permission       | Who by default                    |
| ---------------------------------------------------------------------------------------------- | ---------------- | --------------------------------- |
| See settlements, outstanding COD, discrepancies, costs and the summary                         | `finance:read`   | owner, admin, manager, accountant |
| Import a statement, re-check, reconcile a clean settlement                                     | `finance:import` | owner, admin, accountant          |
| Match / undo a match / set a line aside, resolve or waive a discrepancy, record or void a cost | `finance:adjust` | owner, admin                      |

Every manual decision requires a **reason of at least three characters**, is added to the line's history (with who and when),
and is written to the audit trail. Staff cannot see finance at all.

## API

`POST /v1/settlements/import` (with `dryRun`), `GET /v1/settlements/batches`, `GET /v1/settlements/batches/:id`,
`POST /v1/settlements/batches/:id/reconcile`, `GET /v1/settlements/unmatched`, `GET /v1/settlements/items/:id`,
`POST /v1/settlements/items/:id/match | unmatch | ignore`, `GET /v1/finance/discrepancies`,
`POST /v1/finance/discrepancies/:id/resolve`, `POST /v1/finance/recheck`, `GET /v1/finance/outstanding`,
`GET /v1/finance/summary`, `GET/POST /v1/finance/costs`, `POST /v1/finance/costs/:id/void`. See `docs/openapi.json`.

## Tests

- `packages/domain/src/settlements.test.ts`: reading amounts and dates (including a property test that every paisa value
  survives a round trip through text), the file format, line keys, every matching rule, cash position (including a property
  test that outstanding is never negative), and profit (property test: income − costs = profit).
- `apps/api/test/dashboard.e2e.test.ts` (one fixture with a discount and delivery charge: dashboard, summary and analytics agree; courier cost kinds refused; old rows counted only without statements) and `apps/api/test/finance.e2e.test.ts` (real database): **the fictional statement** (paid, partial, missing,
  duplicate, cash-before-delivery, returned-order, wrong-arithmetic, bare-number, not-ours, conflicting and unallocated lines,
  with exact totals), idempotent imports (same file five times at once, resaved file, overlapping files, transaction ids),
  refusal of bad files, exact paisa, manual matching with history and audit, permissions, waiving, reconciliation refusal and
  reopening, later cash closing a shortfall, profit worked out to the paisa, withheld profit, cancelled and returned orders,
  idempotent costs, tenant isolation, and the database refusing duplicates, bad sums and deletions.
- `apps/web/e2e/finance.spec.ts`: import, check, repeat import, settle each line and reconcile; the overview's separate
  figures and sources; costs; empty states; accessibility and phone width.

## Not built

Importing real Pathao or Steadfast export files without rearranging columns; bank or wallet reconciliation (statements say
what a courier reports, not what reached a bank); matching a payout to a bank deposit; partial delivery; taxes, VAT and
multi-currency; period closing; a payouts-expected-by date or ageing buckets beyond "days since delivery"; exporting reports.
