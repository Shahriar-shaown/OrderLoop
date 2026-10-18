# Building screens to the design

Read `docs/design/README.md` (tokens, layout rules, what is intentionally left out) and look at the PNGs in `docs/design/figma/`. The screens are written once in `packages/features/src/screens` against `@orderloop/ui` and run on the web (react-native-web) and on native.

## Rules

1. **Use the shared components.** Everything visual comes from `@orderloop/ui` (generic) or `packages/features/src/components` (knows about orders, couriers, money). No raw colours, sizes or fonts in a screen: use tokens (`useTheme().colors`, `space`, `radius`, `type`) and the `Text` variants. If a pattern appears twice, make it a component: generic → `packages/ui/src/<Name>.tsx` (export it from `index.ts`); domain → `packages/features/src/components/<Name>.tsx`. Never copy a block of JSX between screens.
2. **Responsive, always.** Use `useBreakpoint()` (`isMobile` < 768, `isTablet`, `isDesktop` ≥ 1280), `Grid` (columns per breakpoint), `Split` (main + aside; the aside stacks under the main column below desktop), `DataTable` with `show: 'wide' | 'desktop'` columns and `renderCard` for phones, `Sheet` (drawer on desktop/tablet, bottom sheet on phone), `Tabs variant="chips"` for filters. Nothing may scroll sideways at 390 px except a table or chart that says so. Touch targets ≥ 44 px on phones (Button, TextField, FilterMenu do this already).
3. **Real data only.** Every figure comes from the API client (`useApi()`); money through `formatPrice` (৳, lakh/crore grouping) and tabular numerals (`<Text numeric>`). Nothing is invented or hard-coded. Where the design shows something the product cannot do, leave it out (see "Where the product intentionally differs"). Delivered is never "paid"; use `PaymentBadge`.
4. **States.** Every data view has loading (`Skeleton` / `DataTable loading`), empty (`EmptyState` with an icon and the next step), and error (`QueryBoundary`, which has Retry) states, and busy states on buttons (`loading`).
5. **Accessibility.** One `PageHeader` (the one h1) per screen; every input has a label; status is words plus a dot (`Badge dot`), never colour alone; icon-only buttons have an `accessibilityLabel`; dialogs/sheets have titles. The Playwright suite runs an axe scan.
6. **Permissions.** Hide what a role cannot do with `useCan()`; the API still enforces it.
7. **Copy.** Plain sentence-case words: say what happened and what to do next. Names of states match the product (Expected, Collected, Settled).

## Components you will use

`@orderloop/ui`: `Text` (variants display=H1, title=H2, heading=H3, metric, body, label, small, fine, caption; `numeric`), `Button` (primary / secondary / tertiary / danger / ghost / link; `icon`, `iconRight`, `loading`, `href`, icon-only with `accessibilityLabel`), `Icon` (`ICON_NAMES` in `icons.ts`), `Badge` (`tone`, `dot`), `Card`, `Section`, `PageHeader` (`breadcrumbs`, `badges`, `actions`), `StatCard` (KPI: `icon`, `hint`, `tone`), `Delta`, `Tabs` (`underline` | `segmented` | `chips`, counts), `SearchField`, `FilterMenu`, `Menu`, `Popover`, `Sheet`, `Dialog` / `FormDialog` / `ConfirmDialog` (`icon`), `DataTable` (`selection`, `onRowPress`, `renderCard`, `loading`, `empty`, `footer`, `show`), `Pagination`, `KeyValueList` (`layout="inline"`, `emphasis`), `Timeline`, `ProgressBar` (single or segmented), `AreaChart`, `DonutChart`, `WaterfallChart`, `BarChart`, `Avatar`, `Alert` (banner with `title`, `action`), `EmptyState`, `Skeleton`, `RadioGroup`, `Switch`, `Checkbox`, `TextField` (`leadingIcon`), `SelectField`, `Grid`, `Split`, `PageStack`, `Breadcrumbs`, `Logo`, `Toast` (`useToast`).

`packages/features`: `OrderStatusBadge`, `PaymentBadge`, `ShipmentStatusBadge`, `QueryBoundary`, forms helpers (`useFormState`, `useZodForm`), money (`formatPrice`, `formatPriceShort`, `parsePrice`), dates (`formatShortDay`, `formatDayTime`, `formatWhen`, `timeAgo`, `dayBefore`), labels in `orders.ts`, `couriers.ts` (`COURIER_NAME`, `SHIPMENT_LABEL`), `finance.ts`.

## Data you can read (all through `useApi()`)

`orders.list` (rows carry `itemsSummary`, `payment`, `courier`; the page carries `statusCounts` for the status chips), `orders.get`, `finance.orderCash`, `shipments.list` / `shipments.stats` / `shipments.forOrder` / `shipments.get`, `couriers.list`, `inventory.summary`, `inventory.list`, `products.list`, `finance.summary` (figures with sources, `manualCostsByKind`), `finance.analytics` (daily, channels, top products), `finance.outstanding`, `finance.batches` / `finance.batch`, `dashboard.get`.

## Do not

Run Playwright or the web build (they share ports and a database with other work); run `pnpm --filter @orderloop/features typecheck`, `test` and `lint` instead. Edit files another screen owns. Invent API data or fields. Add a colour, a font, or a one-off spacing value.
