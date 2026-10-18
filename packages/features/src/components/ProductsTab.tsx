import type { Product } from '@orderloop/contracts';
import {
  Badge,
  Button,
  ConfirmDialog,
  DataTable,
  EmptyState,
  FilterMenu,
  Grid,
  Link,
  Menu,
  Pagination,
  Row,
  SearchField,
  Stack,
  Tabs,
  Text,
  useBreakpoint,
  useToast,
  type Column,
  type MenuItem,
} from '@orderloop/ui';
import { keepPreviousData, useQuery, useQueryClient } from '@tanstack/react-query';
import { useMemo, useState } from 'react';
import { messageFor } from '../errors';
import { useCategories, useDebounced } from '../hooks';
import { useCan } from '../permissions';
import { useApi } from '../runtime';
import {
  costRange,
  marginRange,
  priceRange,
  ProductCard,
  ProductThumb,
  skuSummary,
  stockCount,
} from './ProductCard';
import { QueryBoundary } from './QueryBoundary';
import { productStockStatus, StockStatusBadge } from './StockStatusBadge';

const PAGE_SIZE = 25;
const STATUS_OPTIONS = [
  { value: 'ACTIVE', label: 'Active' },
  { value: 'ARCHIVED', label: 'Archived' },
];
const STOCK_OPTIONS = [
  { value: 'in', label: 'In stock' },
  { value: 'low', label: 'Low' },
  { value: 'out', label: 'Out of stock' },
];
const VIEWS = [
  { value: 'table', label: 'Table' },
  { value: 'grid', label: 'Grid' },
];

type StockFilter = '' | 'in' | 'low' | 'out';
const matchesStock = (p: Product, filter: StockFilter) => {
  if (!filter) return true;
  const level = productStockStatus(p).level;
  return filter === 'low' ? level === 'low' || level === 'critical' : level === filter;
};

/** The product list: search, category / stock / status filters, table or grid, and cursor paging. */
export function ProductsTab({
  total,
  onStock,
}: {
  /** All products when no filter is on (from the inventory summary), for "Showing 1–25 of N". */
  total?: number | undefined;
  onStock: (mode: 'receive' | 'adjust', product: Product) => void;
}) {
  const api = useApi();
  const can = useCan();
  const toast = useToast();
  const queryClient = useQueryClient();
  const { isMobile } = useBreakpoint();
  const [search, setSearch] = useState('');
  const [status, setStatus] = useState('ACTIVE');
  const [categoryId, setCategoryId] = useState('');
  const [stock, setStock] = useState<StockFilter>('');
  const [view, setView] = useState('table');
  const [archiving, setArchiving] = useState<Product | null>(null);
  const [busy, setBusy] = useState(false);
  const q = useDebounced(search.trim());
  const categories = useCategories();
  const categoryName = useMemo(
    () => new Map((categories.data ?? []).map((c) => [c.id, c.name])),
    [categories.data],
  );
  const categoryOptions = useMemo(
    () => (categories.data ?? []).map((c) => ({ value: c.id, label: c.name })),
    [categories.data],
  );

  // Cursor paging: the cursors of the pages already visited; changing a filter starts again from the first page.
  const filterKey = JSON.stringify([q, status, categoryId]);
  const [paging, setPaging] = useState<{ key: string; cursors: string[] }>({
    key: filterKey,
    cursors: [],
  });
  const cursors = paging.key === filterKey ? paging.cursors : [];
  const cursor = cursors[cursors.length - 1];
  const products = useQuery({
    queryKey: ['products', { q, status, categoryId, cursor }],
    queryFn: () =>
      api.products.list({
        limit: PAGE_SIZE,
        ...(q ? { q } : {}),
        ...(status ? { status: status as 'ACTIVE' | 'ARCHIVED' } : {}),
        ...(categoryId ? { categoryId } : {}),
        ...(cursor ? { cursor } : {}),
      }),
    placeholderData: keepPreviousData,
  });
  const nextCursor = products.data?.nextCursor ?? null;
  const all = products.data?.items ?? [];
  const items = all.filter((p) => matchesStock(p, stock));
  const filtered = q !== '' || status !== 'ACTIVE' || categoryId !== '' || stock !== '';
  const first = cursors.length * PAGE_SIZE + 1;
  const summary =
    all.length === 0
      ? 'No products'
      : q === '' && status === 'ACTIVE' && categoryId === '' && stock === '' && total !== undefined
        ? `Showing ${first}–${first + all.length - 1} of ${total} products`
        : `Showing ${items.length} product${items.length === 1 ? '' : 's'}${
            stock ? ' on this page' : ''
          }`;

  async function setArchived(product: Product, archive: boolean) {
    setBusy(true);
    try {
      await api.products.update(product.id, { status: archive ? 'ARCHIVED' : 'ACTIVE' });
      await Promise.all(
        ['product', 'products', 'inventory'].map((k) =>
          queryClient.invalidateQueries({ queryKey: [k] }),
        ),
      );
      toast.success(archive ? 'Archived' : 'Restored');
      setArchiving(null);
    } catch (error) {
      toast.error(messageFor(error));
    } finally {
      setBusy(false);
    }
  }

  const rowMenu = (p: Product) => {
    const live = p.status === 'ACTIVE';
    const menuItems: MenuItem[] = [
      { key: 'open', label: 'Open', icon: 'list', href: `/products/${p.id}` },
      ...(can('inventory:write') && live
        ? [
            {
              key: 'receive',
              label: 'Receive stock',
              icon: 'box' as const,
              onPress: () => onStock('receive', p),
            },
            {
              key: 'adjust',
              label: 'Adjust stock',
              icon: 'edit' as const,
              onPress: () => onStock('adjust', p),
            },
          ]
        : []),
      ...(can('catalog:write')
        ? [
            live
              ? {
                  key: 'archive',
                  label: 'Archive',
                  icon: 'trash' as const,
                  danger: true,
                  onPress: () => setArchiving(p),
                }
              : {
                  key: 'restore',
                  label: 'Restore',
                  icon: 'refresh' as const,
                  onPress: () => void setArchived(p, false),
                },
          ]
        : []),
    ];
    return <Menu items={menuItems} label={`Actions for ${p.name}`} />;
  };

  const columns: Column<Product>[] = [
    {
      key: 'name',
      header: 'Product',
      flex: 4,
      minWidth: 240,
      render: (p) => (
        <Row gap={3} align="center">
          <ProductThumb />
          <Stack gap={1} style={{ flexShrink: 1 }}>
            <Link href={`/products/${p.id}`} weight="medium">
              {p.name}
            </Link>
            <Text variant="caption" tone="muted">
              {skuSummary(p)}
            </Text>
          </Stack>
        </Row>
      ),
    },
    {
      key: 'category',
      header: 'Category',
      flex: 2,
      minWidth: 130,
      show: 'wide',
      render: (p) => (p.categoryId ? (categoryName.get(p.categoryId) ?? '—') : '—'),
    },
    {
      key: 'price',
      header: 'Price',
      align: 'right',
      flex: 2,
      minWidth: 110,
      render: (p) => <Text numeric>{priceRange(p)}</Text>,
    },
    {
      key: 'cost',
      header: 'Cost',
      align: 'right',
      flex: 2,
      minWidth: 100,
      show: 'desktop',
      render: (p) => (
        <Text numeric tone="muted">
          {costRange(p) ?? '—'}
        </Text>
      ),
    },
    {
      key: 'margin',
      header: 'Margin',
      align: 'right',
      minWidth: 90,
      show: 'desktop',
      render: (p) => <Text numeric>{marginRange(p) ?? '—'}</Text>,
    },
    {
      key: 'stock',
      header: 'In stock',
      align: 'right',
      minWidth: 90,
      render: (p) => <Text numeric>{String(stockCount(p))}</Text>,
    },
    {
      key: 'status',
      header: 'Status',
      flex: 2,
      minWidth: 150,
      render: (p) =>
        p.status === 'ARCHIVED' ? (
          <Badge dot>Archived</Badge>
        ) : (
          <StockStatusBadge status={productStockStatus(p)} />
        ),
    },
    {
      key: 'actions',
      header: 'Actions',
      align: 'right',
      minWidth: 72,
      render: rowMenu,
    },
  ];

  const empty = (
    <EmptyState
      icon="box"
      title={filtered ? 'No products match' : 'No products yet'}
      action={
        !filtered && can('catalog:write') ? (
          <Button href="/products/new">Add your first product</Button>
        ) : undefined
      }
    >
      {filtered
        ? 'Try a different search or filter.'
        : can('catalog:write')
          ? 'Add a product, or import a CSV.'
          : 'Ask someone with catalog access to add products.'}
    </EmptyState>
  );

  const paging_ = (
    <Pagination
      summary={summary}
      hasPrevious={cursors.length > 0}
      hasNext={nextCursor !== null}
      onPrevious={() => setPaging({ key: filterKey, cursors: cursors.slice(0, -1) })}
      onNext={() => nextCursor && setPaging({ key: filterKey, cursors: [...cursors, nextCursor] })}
    />
  );

  return (
    <Stack gap={4}>
      <Row gap={3} wrap align="center">
        <Stack grow style={{ minWidth: 240, maxWidth: 420 }}>
          <SearchField
            label="Search products"
            placeholder="Search by product name or SKU"
            value={search}
            onChangeText={setSearch}
          />
        </Stack>
        <FilterMenu
          label="Category"
          value={categoryId}
          options={categoryOptions}
          onChange={setCategoryId}
        />
        <FilterMenu
          label="Stock"
          value={stock}
          options={STOCK_OPTIONS}
          onChange={(v) => setStock(v as StockFilter)}
        />
        <FilterMenu label="Status" value={status} options={STATUS_OPTIONS} onChange={setStatus} />
        {!isMobile && (
          <Stack style={{ marginLeft: 'auto' }}>
            <Tabs
              variant="segmented"
              label="Product view"
              items={VIEWS}
              value={view}
              onChange={setView}
            />
          </Stack>
        )}
      </Row>
      <QueryBoundary {...products} refetch={() => products.refetch()} label="Loading products">
        {items.length === 0 ? (
          empty
        ) : view === 'grid' && !isMobile ? (
          <Stack gap={4}>
            <Grid columns={{ mobile: 1, tablet: 2, desktop: 3 }}>
              {items.map((p) => (
                <ProductCard
                  key={p.id}
                  product={p}
                  categoryName={p.categoryId ? categoryName.get(p.categoryId) : undefined}
                  menu={rowMenu(p)}
                />
              ))}
            </Grid>
            {paging_}
          </Stack>
        ) : (
          <DataTable
            label="Products"
            columns={columns}
            rows={items}
            rowKey={(p) => p.id}
            rowHeight={60}
            loading={products.isPlaceholderData}
            renderCard={(p) => (
              <ProductCard
                bare
                product={p}
                categoryName={p.categoryId ? categoryName.get(p.categoryId) : undefined}
                menu={rowMenu(p)}
              />
            )}
            footer={paging_}
          />
        )}
      </QueryBoundary>
      <ConfirmDialog
        open={archiving !== null}
        title="Archive this product?"
        confirmLabel="Archive"
        danger
        busy={busy}
        onClose={() => setArchiving(null)}
        onConfirm={() => archiving && setArchived(archiving, true)}
      >
        It disappears from the default product list and stock can no longer change. You can restore
        it later.
      </ConfirmDialog>
    </Stack>
  );
}
