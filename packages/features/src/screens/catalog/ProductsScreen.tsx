import type { Product } from '@orderloop/contracts';
import { Button, Grid, Menu, PageHeader, Stack, StatCard, Tabs } from '@orderloop/ui';
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { CategoriesPanel } from '../../components/catalog/CategoriesPanel';
import { useCsvExport } from '../../shell/ExportButtons';
import { LowStockTab } from '../../components/inventory/LowStockTab';
import { MovementsTab } from '../../components/inventory/MovementsTab';
import { ProductsTab } from '../../components/catalog/ProductsTab';
import { ReservationsTab } from '../../components/inventory/ReservationsTab';
import {
  StockDialog,
  type StockMode,
  type VariantRef,
} from '../../components/inventory/StockDialog';
import { useCategories } from '../../lib/hooks';
import { formatPrice } from '../../lib/money';
import { useCan } from '../../core/permissions';
import { useApi } from '../../core/runtime';

export type ProductsTabName = 'products' | 'movements' | 'low' | 'categories' | 'reservations';
const TAB_NAMES: ProductsTabName[] = ['products', 'movements', 'low', 'categories', 'reservations'];

/** `?tab=low` in the address (web), else the screen's own default. */
function tabFromUrl(fallback: ProductsTabName): ProductsTabName {
  try {
    const wanted = new URLSearchParams(globalThis.location?.search ?? '').get('tab');
    return TAB_NAMES.find((t) => t === wanted) ?? fallback;
  } catch {
    return fallback;
  }
}

type StockRequest = {
  mode: StockMode;
  variant: VariantRef | null;
  product: Product | null;
  picker: boolean;
} | null;

/**
 * Products & inventory: the catalogue and its stock in one place. The tab decides what is below the figures; `/inventory` and
 * `/categories` open this same page on their own tab.
 */
export function ProductsScreen({
  initialTab = 'products',
  tab: requestedTab,
}: {
  initialTab?: ProductsTabName;
  /** The tab a link asked for (`?tab=low`); wins over the screen's own default. Anything unknown is ignored. */
  tab?: string | undefined;
}) {
  const api = useApi();
  const can = useCan();
  const [tab, setTab] = useState<ProductsTabName>(
    () => TAB_NAMES.find((t) => t === requestedTab) ?? tabFromUrl(initialTab),
  );
  const [request, setRequest] = useState<StockRequest>(null);
  const categories = useCategories();
  const exporter = useCsvExport(['products', 'stock']);
  const summary = useQuery({
    queryKey: ['inventory', 'summary'],
    queryFn: () => api.inventory.summary(),
    enabled: can('inventory:read'),
  });
  const s = summary.data;

  const description = s
    ? `${s.products} product${s.products === 1 ? '' : 's'} · ${s.variants} SKU${
        s.variants === 1 ? '' : 's'
      } · inventory value ${formatPrice(s.inventoryValueCostMinor)} at cost`
    : undefined;

  const askProduct = (mode: 'receive' | 'adjust', product: Product) =>
    setRequest({ mode, variant: null, product, picker: true });

  return (
    <Stack gap={5}>
      <PageHeader
        title="Products & inventory"
        {...(description ? { description } : {})}
        actions={
          <>
            {can('catalog:write') && (
              <Button variant="secondary" icon="upload" href="/imports">
                Bulk import
              </Button>
            )}
            {can('inventory:write') && (
              <Button
                variant="secondary"
                icon="edit"
                onPress={() =>
                  setRequest({ mode: 'adjust', variant: null, product: null, picker: true })
                }
              >
                Adjust stock
              </Button>
            )}
            {can('catalog:write') && (
              <Button icon="plus" href="/products/new">
                Add product
              </Button>
            )}
            <Menu
              label="More actions"
              items={[
                { key: 'suppliers', label: 'Suppliers', icon: 'store', href: '/suppliers' },
                { key: 'locations', label: 'Locations', icon: 'pin', href: '/locations' },
                ...exporter.menuItems(),
              ]}
            />
          </>
        }
      />
      {s && (
        <Grid columns={{ mobile: 2, desktop: 4 }}>
          <StatCard
            label="Inventory value (cost)"
            value={formatPrice(s.inventoryValueCostMinor)}
            icon="layers"
            hint={
              s.missingCostVariants > 0
                ? `${s.missingCostVariants} item${s.missingCostVariants === 1 ? ' has' : 's have'} no cost price`
                : 'On hand × cost price'
            }
          />
          <StatCard
            label="Retail value"
            value={formatPrice(s.retailValueMinor)}
            icon="tag"
            hint="On hand × selling price"
          />
          <StatCard
            label="Low stock"
            value={String(s.lowStockCount)}
            icon="alert"
            tone={s.lowStockCount > 0 ? 'warning' : 'default'}
            hint="At or below the reorder point"
          />
          <StatCard
            label="Out of stock"
            value={String(s.outOfStockCount)}
            icon="box"
            tone={s.outOfStockCount > 0 ? 'danger' : 'default'}
            hint="No units available"
          />
        </Grid>
      )}
      <Tabs
        label="Products and inventory views"
        value={tab}
        onChange={(v) => setTab(v as ProductsTabName)}
        items={[
          { value: 'products', label: 'Products', count: s?.products },
          { value: 'movements', label: 'Stock movements' },
          { value: 'low', label: 'Low stock', count: s?.lowStockCount },
          { value: 'categories', label: 'Categories', count: categories.data?.length },
          { value: 'reservations', label: 'Reservations' },
        ]}
      />
      {tab === 'products' && <ProductsTab total={s?.products} onStock={askProduct} />}
      {tab === 'movements' && <MovementsTab />}
      {tab === 'low' && (
        <LowStockTab
          onReceive={(variant) =>
            setRequest({ mode: 'receive', variant, product: null, picker: false })
          }
        />
      )}
      {tab === 'categories' && <CategoriesPanel />}
      {tab === 'reservations' && <ReservationsTab />}
      <StockDialog
        mode={request?.mode ?? 'receive'}
        variant={request?.variant ?? null}
        picker={request?.picker ?? false}
        product={request?.product ?? null}
        onClose={() => setRequest(null)}
      />
    </Stack>
  );
}
