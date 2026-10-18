# Web dashboard

The seller's daily screens, in the existing Next.js app, built from the shared `packages/ui` and `packages/features` (so the
mobile app shows the same screens). This milestone adds the **Dashboard** and **Team and permissions**; the other sections
(Orders, Customers, Products and inventory, Settings) were built in earlier milestones and are now one menu, with Dashboard as
the first page after sign-in.

> The product is called OrderLoop throughout the code, docs and screens; the milestone brief said "CommercePilot BD". The name was
> not changed.

## Menu

Dashboard, Orders, Customers, Products, Stock, Categories, Locations, Suppliers, Import, Team (only for roles that may see the team),
Settings. On a phone the menu folds behind a **Menu** button (with `aria-expanded`) and closes after you pick a page. The
business switcher and sign-out stay in the header.

## Dashboard

`GET /v1/dashboard?period=today|7d|30d` (permission `orders:read`, so every role can see it). Everything on the page is a figure
the server worked out from the business's own rows; the browser only formats. A period is whole calendar days **in the
business's own time zone** (Settings), so "today" starts at local midnight, not UTC midnight. Orders are placed in a period by
**when they were created**.

| On the page            | What it is                                                                                                                                                                                          |
| ---------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Needs your attention   | **All** open work, not just the period: orders waiting to be confirmed, confirmed orders to pack and ship, failed deliveries, return requests, low-stock products. Each links to the filtered list. |
| Orders                 | Orders created in the period.                                                                                                                                                                       |
| Sales                  | Total of the period's orders that were **not cancelled** (items − discounts + delivery charges), and how many orders that is.                                                                       |
| Delivered sales        | Total of the period's delivered orders.                                                                                                                                                             |
| Cash on delivery out   | COD amount (total − advance) on orders currently shipped or in transit: what couriers should be collecting.                                                                                         |
| Average order          | Sales ÷ orders counted, whole paisa. `—` when there are none.                                                                                                                                       |
| Delivery success       | delivered ÷ (delivered + failed + returned). `—` until one of those exists. Returns count against it.                                                                                               |
| Orders / Sales per day | Real bars: one per calendar day, zero days included. Screen readers get a sentence with every number.                                                                                               |
| Orders by status       | Every status, zeros included, each linking to the list for that status and period.                                                                                                                  |
| Low stock              | The five thinnest active products at or below their reorder point (all locations together; damaged units are not available), with the full count.                                                   |
| Recent activity        | The latest 12 order status changes, newest first, with who made them. Order numbers only: no customer names or phones.                                                                              |

States: a loading indicator, an error with **Try again**, a welcome with real next steps (Add a product, Receive stock, Take an
order) when the business is brand new, and "Nothing needs your attention right now." when it is true. Switching period keeps the
previous figures on screen while the next ones load. There are no sample figures anywhere.

### Profit

Profit is **never shown unless it can be worked out**, and is always labelled an **estimate**:

- It is the item revenue of the period's **delivered** orders minus the **cost price recorded on each line when it was sold**
  (so changing a product's cost later does not rewrite past orders).
- It is shown only when **every** delivered line in the period has a cost price. Otherwise the page says why ("1 of 2 delivered
  order lines have no cost price, so profit cannot be worked out. Add cost prices to your products.") and shows no figure.
- It leaves out order-level discounts, delivery charges, courier fees, returns and taxes, and the page says so under the figure.
  Courier fees and COD settlement belong to a later milestone.

## Team and permissions

For owners and admins (`members:invite`, `members:manage`): the people in the business with their roles, **pending invitations**,
an **Invite someone** dialog (validated email, only roles you may grant), **Change role** and **Remove** (with a confirmation
dialog that says what happens) and **Revoke** invitation (also confirmed). You cannot act on yourself, and an admin cannot touch
owners or admins, exactly as the server enforces (`403`/`409` messages appear as a notice if anything slips through).

For everyone: your own role in words, and **what each role can do**, a table generated from the same permission map the server
enforces (`ROLE_PERMISSIONS`), so it cannot drift. For owners and admins: the latest administrative activity from the audit log.
Roles belong to a business: the same person can hold different roles in different businesses.

Inviting needs a verified email address; if yours is not, the server says so and the verification banner is on every page.

## Everything else on the menu

Orders, Customers, Products and inventory (products, stock, categories, locations, suppliers, import), and Settings (business
profile, regional settings, language) are described in [orders.md](orders.md), [inventory.md](inventory.md) and
[permissions.md](permissions.md). All of it reads and writes the real API; business data is isolated by workspace by the same
row-level security as the API, and switching workspace clears every cached answer.

One change to sign-in: with no business named, signing in now returns to the business you **last used** (the latest session's
active business, if you still belong to it), instead of the newest one you joined.

## Responsive and accessible

Pages use the shared layout primitives (`FieldGrid` wraps cards to the width available, `DataTable` scrolls sideways inside its
own frame instead of widening the page). Browser tests check every main page at 375 px for horizontal overflow and run an
accessibility scan (WCAG A/AA via axe) on desktop and phone. Forms use labelled fields with specific error messages; dialogs
are native `<dialog>` elements with focus handling; destructive actions ask first; colour is never the only signal (badges carry
words).

## Tests

- `apps/api/test/dashboard.e2e.test.ts`: every figure and its definition, time zones (including "today" in a zone far from UTC),
  period edges, the profit rules (estimate, withheld when a cost is missing, uses the cost at the time of sale), attention counts
  over all time, low stock, recent activity, no personal data in the response, isolation between businesses, switching business,
  roles.
- `packages/features`: dashboard states (loading, figures, estimate label, withheld profit, welcome, error and retry, period
  requests) and the team page (matrix, validation, confirmations, what an admin may and may not do).
- `apps/web/e2e/dashboard.spec.ts`: seeded figures checked against the page, links to filtered lists, period switching, workspace
  isolation, an injected server error and retry, an accountant's view, and a phone.
- `apps/web/e2e/daily-work.spec.ts`: **the checkpoint**: sign-up, email verification, settings, a second workspace, supplier,
  product with cost and stock, an order from a new customer confirmed and taken through to delivered, a second order cancelled
  (stock returns), the dashboard's figures and estimated profit, search and CSV export, then the team: invite, a second person
  joining, a role change, confirmations, removal, and sign-out and back in. Nothing in it touches the database.
- Also in the browser suites: login (`auth.spec.ts`), workspace creation (`workspaces.spec.ts`), product management
  (`catalog.spec.ts`, `inventory.spec.ts`) and order creation (`orders.spec.ts`).

## Not done / limits

- No charts beyond the two daily bar charts, and no date-range picker beyond today / 7 / 30 days.
- No courier, COD settlement or payout screens, so no profit after courier fees; the dashboard says what the estimate excludes.
- Notifications and email digests are not built; the dashboard is pull-only (the Refresh button, and it refetches when you
  change period or return to it).
- Product images are links, and there is no file storage yet.
- The mobile app shows these screens (same code), but they were not driven on a simulator or device.
