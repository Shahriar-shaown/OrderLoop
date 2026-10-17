import type { Product } from '@orderloop/contracts';
import {
  Badge,
  Button,
  DataTable,
  EmptyState,
  FieldGrid,
  Link,
  LoadMore,
  PageHeader,
  SelectField,
  Stack,
  Text,
  TextField,
  type Column,
} from '@orderloop/ui';
import { useInfiniteQuery } from '@tanstack/react-query';
import { useMemo, useState } from 'react';
import { QueryBoundary } from '../components/QueryBoundary';
import { useCategories, useDebounced } from '../hooks';
import { formatPrice } from '../money';
import { useCan } from '../permissions';
import { useApi } from '../runtime';

function priceRange(p: Product): string {
  const prices = p.variants.filter((v) => !v.archived).map((v) => v.priceMinor);
  if (prices.length === 0) return '—';
  const lo = Math.min(...prices);
  const hi = Math.max(...prices);
  return lo === hi ? formatPrice(lo) : `${formatPrice(lo)} – ${formatPrice(hi)}`;
}

const STATUS_OPTIONS = [
  { value: 'ACTIVE', label: 'Active' },
  { value: 'ARCHIVED', label: 'Archived' },
  { value: 'ALL', label: 'All' },
];

export function ProductsScreen() {
  const api = useApi();
  const can = useCan();
  const [search, setSearch] = useState('');
  const [status, setStatus] = useState<'ACTIVE' | 'ARCHIVED' | 'ALL'>('ACTIVE');
  const [categoryId, setCategoryId] = useState('');
  const q = useDebounced(search.trim());
  const categories = useCategories();
  const categoryName = useMemo(
    () => new Map((categories.data ?? []).map((c) => [c.id, c.name])),
    [categories.data],
  );
  const categoryOptions = useMemo(
    () => [
      { value: '', label: 'All categories' },
      ...(categories.data ?? []).map((c) => ({ value: c.id, label: c.name })),
    ],
    [categories.data],
  );

  const products = useInfiniteQuery({
    queryKey: ['products', { q, status, categoryId }],
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }) =>
      api.products.list({
        limit: 25,
        ...(q ? { q } : {}),
        ...(status !== 'ALL' ? { status } : {}),
        ...(categoryId ? { categoryId } : {}),
        ...(pageParam ? { cursor: pageParam } : {}),
      }),
    getNextPageParam: (last) => last.nextCursor ?? undefined,
  });
  const items = products.data?.pages.flatMap((p) => p.items) ?? [];
  const filtered = q !== '' || status !== 'ACTIVE' || categoryId !== '';

  const columns: Column<Product>[] = [
    {
      key: 'name',
      header: 'Product',
      flex: 3,
      minWidth: 220,
      render: (p) => (
        <Stack gap={1}>
          <Link href={`/products/${p.id}`} weight="medium">
            {p.name}
          </Link>
          <Text variant="caption" tone="muted">
            {p.variants
              .map((v) => v.sku)
              .slice(0, 3)
              .join(', ')}
            {p.variants.length > 3 ? '…' : ''}
          </Text>
        </Stack>
      ),
    },
    {
      key: 'category',
      header: 'Category',
      flex: 2,
      render: (p) => (p.categoryId ? (categoryName.get(p.categoryId) ?? '—') : 'None'),
    },
    {
      key: 'variants',
      header: 'Variants',
      minWidth: 90,
      flex: 1,
      render: (p) => String(p.variants.length),
    },
    { key: 'price', header: 'Price', flex: 2, minWidth: 140, render: priceRange },
    {
      key: 'available',
      header: 'Available',
      align: 'right',
      minWidth: 110,
      flex: 1,
      render: (p) => `${p.variants.reduce((n, v) => n + v.stock.available, 0)} ${p.unit}`,
    },
    {
      key: 'status',
      header: 'Status',
      minWidth: 100,
      flex: 1,
      render: (p) => (
        <Badge tone={p.status === 'ACTIVE' ? 'success' : 'neutral'}>
          {p.status === 'ACTIVE' ? 'Active' : 'Archived'}
        </Badge>
      ),
    },
  ];

  return (
    <Stack gap={5}>
      <PageHeader
        title="Products"
        description="Everything you sell. Each product has one or more variants (SKUs) that carry the price and the stock."
        actions={
          can('catalog:write') ? <Button href="/products/new">New product</Button> : undefined
        }
      />
      <FieldGrid minWidth={200}>
        <TextField
          label="Search"
          kind="search"
          placeholder="Name or SKU"
          value={search}
          onChangeText={setSearch}
        />
        <SelectField
          label="Category"
          options={categoryOptions}
          value={categoryId}
          onChange={setCategoryId}
        />
        <SelectField
          label="Status"
          options={STATUS_OPTIONS}
          value={status}
          onChange={(v) => setStatus(v as typeof status)}
        />
      </FieldGrid>
      <QueryBoundary {...products} refetch={() => products.refetch()} label="Loading products">
        {items.length === 0 ? (
          <EmptyState
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
        ) : (
          <>
            <DataTable label="Products" columns={columns} rows={items} rowKey={(p) => p.id} />
            <LoadMore
              hasNext={!!products.hasNextPage}
              loading={products.isFetchingNextPage}
              onPress={() => products.fetchNextPage()}
            />
          </>
        )}
      </QueryBoundary>
    </Stack>
  );
}
