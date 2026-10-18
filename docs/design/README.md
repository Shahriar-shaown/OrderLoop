# Design reference

Source: the Figma file **OrderLoop — Product UI/UX** (file key `l6k93oEwK8RoKRXZJH4npj`, pages `00–01 Cover, Brand & Design System` and `02–05 Desktop App, Order Workflows, Finance, Integrations`). The PNGs in `figma/` are exports of those frames, kept so the screens can be built and reviewed without Figma access.

| File                                         | Frame                                                |
| -------------------------------------------- | ---------------------------------------------------- |
| `figma/colour.png`, `type.png`, `layout.png` | Colour, typography, layout grid and responsive rules |
| `figma/actions.png`, `overlays.png`          | Buttons, dialogs, toasts, menus, tooltip             |
| `figma/dash.png`                             | 01 Overview dashboard                                |
| `figma/orders.png`                           | 02 Orders management                                 |
| `figma/create.png`                           | 03 Create order                                      |
| `figma/detail.png`                           | 04 Order details                                     |
| `figma/products.png`                         | 05 Products & inventory                              |
| `figma/couriers.png`                         | 06 Couriers & shipments                              |
| `figma/cod.png`                              | 07 COD reconciliation                                |
| `figma/analytics.png`                        | 08 Analytics & profit                                |

## Tokens (from the design)

**Colour.** brand/primary `#4F46E5` (hover `#3730A3`, tint-100 `#E0E7FF`, tint-50 `#EEF2FF`); brand/accent teal `#14B8A6` (fills, charts, icons only; text `#0F766E`, tint `#F0FDFA`); bg/app `#F8FAFC`, bg/surface `#FFFFFF`, bg/subtle `#F1F5F9`; border/default `#E2E8F0`, border/strong `#CBD5E1`; text/primary `#0F172A`, text/secondary `#64748B`; status success `#16A34A` (text `#15803D`, bg `#DCFCE7`), warning text `#B45309` bg `#FEF3C7`, error `#DC2626` (text `#B91C1C`, bg `#FEE2E2`), info text `#0369A1` bg `#E0F2FE`; charts indigo `#4F46E5`, teal `#14B8A6`, amber `#F59E0B`, rose `#F43F5E`, sky `#38BDF8`, slate `#94A3B8`. Every status badge also carries a label (never colour alone).

**Type (Inter).** Display 32/40 bold; H1 24/32 semibold (one per page); H2 18/28 semibold; H3 15/22 semibold; Metric 28/36 semibold (tabular figures); Body 14/20; Body medium 14/20 medium; Body small 13/18; Label 12/16 medium; Caption 11/14. Money and counts use tabular numerals; money is shown with ৳ and lakh/crore grouping.

**Spacing** 4 px base: 4, 8, 12, 16, 20, 24, 32, 40, 48. **Radius** sm (chips), md (buttons, inputs), lg (cards, tables), xl (dialogs, panels), full (badges, avatars). Three elevations only.

**Layout.** Desktop ≥ 1280: persistent 248 px sidebar, 64 px header, 12 columns, 24 gutter, 32 margins, content max 1128 (centred above 1600), 6 KPI cards across, tables show every column with 64 px rows and a bulk bar, forms in 2 columns with a sticky 360 px summary, detail in a 480 px drawer or full page. Tablet 768–1279: 72 px icon rail with tooltips, search collapses to an icon, 8 columns, KPIs 3 × 2, tables hide Products and Courier and expand a row for detail, single-column forms with the summary underneath, 420 px drawer. Mobile < 768: 56 px header (shop switcher, search icon), 64 px bottom bar (Home, Orders, +, Shipments, More), KPIs 2 × 3 or horizontal scroll, tables become cards, filters in a bottom sheet with horizontally scrolling chips, primary action pinned above the bar, targets ≥ 44 px.

**Interaction.** Every control has default, hover, focus, active, disabled (and loading) states. Focus ring 3 px indigo at 35 % outside the control, never removed. 150 ms ease-out for hover/menus, 200 ms for drawers; honour reduced motion. ⌘K opens search; Esc closes dialogs and menus. Destructive actions: red button, safe action on the left, reason required for cancellations. Money names its state: Expected, Collected, Settled; unsettled COD is never profit.

## Where the product intentionally differs from the design

The design includes things the product does not do (yet). They are left out rather than faked: Automations and Integrations pages, the plan / billing card, notifications, payment methods (bKash, Nagad, bank transfer) on an order, customer discount codes, team notes on an order, "Print invoice", bulk courier booking, RedX, courier-fee percentages (COD handling 1 %), week-on-week change badges (the API gives one period only), and a custom date range on the dashboard. Where the design shows a figure the product can work out honestly from its records, it is shown with its source; otherwise it is omitted.
