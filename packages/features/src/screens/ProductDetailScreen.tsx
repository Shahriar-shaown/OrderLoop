import type { Product, Variant } from '@orderloop/contracts';
import {
  Alert,
  Badge,
  Button,
  Card,
  ConfirmDialog,
  DataTable,
  KeyValueList,
  Menu,
  PageHeader,
  Row,
  Section,
  Split,
  Stack,
  Text,
  useToast,
  type Column,
  type MenuItem,
} from '@orderloop/ui';
import { useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Image } from 'react-native';
import { priceRange } from '../components/ProductCard';
import { ProductEditDialog } from '../components/ProductEditDialog';
import { QueryBoundary } from '../components/QueryBoundary';
import {
  StockDialog,
  variantRefOf,
  type StockMode,
  type VariantRef,
} from '../components/StockDialog';
import {
  productStockStatus,
  StockStatusBadge,
  variantStockStatus,
} from '../components/StockStatusBadge';
import { VariantDialog } from '../components/VariantDialog';
import { messageFor } from '../errors';
import { useCategories, useProduct, useSuppliers } from '../hooks';
import { formatPrice } from '../money';
import { useCan } from '../permissions';
import { useApi } from '../runtime';

type Archiving = { kind: 'product' } | { kind: 'variant'; variant: Variant } | null;

export function ProductDetailScreen({ id }: { id: string }) {
  const api = useApi();
  const can = useCan();
  const toast = useToast();
  const queryClient = useQueryClient();
  const query = useProduct(id);
  const categories = useCategories();
  const suppliers = useSuppliers();
  const [editing, setEditing] = useState(false);
  const [variantDialog, setVariantDialog] = useState<{ variant: Variant | null } | null>(null);
  const [stock, setStock] = useState<{ mode: StockMode; variant: VariantRef } | null>(null);
  const [archiving, setArchiving] = useState<Archiving>(null);
  const [busy, setBusy] = useState(false);

  const product = query.data;

  async function changeArchived(target: NonNullable<Archiving>, archive: boolean) {
    setBusy(true);
    try {
      if (target.kind === 'product')
        await api.products.update(id, { status: archive ? 'ARCHIVED' : 'ACTIVE' });
      else await api.products.updateVariant(target.variant.id, { archived: archive });
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['product'] }),
        queryClient.invalidateQueries({ queryKey: ['products'] }),
      ]);
      toast.success(archive ? 'Archived' : 'Restored');
      setArchiving(null);
    } catch (error) {
      toast.error(messageFor(error));
    } finally {
      setBusy(false);
    }
  }

  /** The buttons on one variant: receive and adjust up front, the rest in the menu. */
  const actions = (p: Product, v: Variant) => {
    const ref = variantRefOf(p, v);
    const ask = (mode: StockMode) => () => setStock({ mode, variant: ref });
    const stockItems: MenuItem[] =
      can('inventory:write') && !v.archived
        ? [
            { key: 'reserve', label: 'Reserve stock', icon: 'lock', onPress: ask('reserve') },
            { key: 'damage', label: 'Mark as damaged', icon: 'alert', onPress: ask('damage') },
            ...(v.stock.damaged > 0
              ? [
                  {
                    key: 'writeOff',
                    label: 'Write off damaged',
                    icon: 'trash',
                    onPress: ask('writeOff'),
                  } satisfies MenuItem,
                ]
              : []),
            { key: 'return', label: 'Record a return', icon: 'return', onPress: ask('return') },
          ]
        : [];
    const catalogItems: MenuItem[] = can('catalog:write')
      ? [
          {
            key: 'edit',
            label: 'Edit variant',
            icon: 'edit',
            onPress: () => setVariantDialog({ variant: v }),
          },
          {
            key: 'archive',
            label: v.archived ? 'Restore variant' : 'Archive variant',
            icon: v.archived ? 'refresh' : 'trash',
            danger: !v.archived,
            onPress: () =>
              v.archived
                ? void changeArchived({ kind: 'variant', variant: v }, false)
                : setArchiving({ kind: 'variant', variant: v }),
          },
        ]
      : [];
    return (
      <Row gap={1} wrap align="center">
        {can('inventory:write') && !v.archived && (
          <>
            <Button size="sm" variant="secondary" onPress={ask('receive')}>
              Receive
            </Button>
            <Button size="sm" variant="secondary" onPress={ask('adjust')}>
              Adjust
            </Button>
          </>
        )}
        {stockItems.length + catalogItems.length > 0 && (
          <Menu label={`More actions for ${v.sku}`} items={[...stockItems, ...catalogItems]} />
        )}
      </Row>
    );
  };

  const skuCell = (v: Variant) => (
    <Stack gap={1}>
      <Text weight="bold">{v.sku}</Text>
      {v.name ? (
        <Text variant="caption" tone="muted">
          {v.name}
        </Text>
      ) : null}
      {v.archived ? <Badge dot>Archived</Badge> : null}
    </Stack>
  );
  const availableCell = (v: Variant) =>
    v.archived ? (
      <Text numeric>{String(v.stock.available)}</Text>
    ) : (
      <Stack gap={1} align="end">
        <Text numeric>{String(v.stock.available)}</Text>
        {variantStockStatus(v).level !== 'in' && (
          <StockStatusBadge status={variantStockStatus(v)} />
        )}
      </Stack>
    );

  const columns = (p: Product): Column<Variant>[] => [
    { key: 'sku', header: 'SKU', minWidth: 150, flex: 2, render: skuCell },
    {
      key: 'price',
      header: 'Price',
      align: 'right',
      minWidth: 100,
      render: (v) => <Text numeric>{formatPrice(v.priceMinor)}</Text>,
    },
    {
      key: 'cost',
      header: 'Cost',
      align: 'right',
      minWidth: 100,
      show: 'desktop',
      render: (v) => (
        <Text numeric tone="muted">
          {v.costMinor === null ? '—' : formatPrice(v.costMinor)}
        </Text>
      ),
    },
    {
      key: 'onHand',
      header: 'On hand',
      align: 'right',
      minWidth: 80,
      render: (v) => <Text numeric>{String(v.stock.onHand)}</Text>,
    },
    {
      key: 'reserved',
      header: 'Reserved',
      align: 'right',
      minWidth: 80,
      render: (v) => <Text numeric>{String(v.stock.reserved)}</Text>,
    },
    { key: 'available', header: 'Available', align: 'right', minWidth: 130, render: availableCell },
    {
      key: 'damaged',
      header: 'Damaged',
      align: 'right',
      minWidth: 80,
      render: (v) => <Text numeric>{String(v.stock.damaged)}</Text>,
    },
    {
      key: 'actions',
      header: 'Actions',
      flex: 2,
      minWidth: 200,
      render: (v) => actions(p, v),
    },
  ];

  const totals = (p: Product) => {
    const live = p.variants.filter((v) => !v.archived);
    const sum = (f: (v: Variant) => number) => live.reduce((n, v) => n + f(v), 0);
    return {
      onHand: sum((v) => v.stock.onHand),
      reserved: sum((v) => v.stock.reserved),
      available: sum((v) => v.stock.available),
      damaged: sum((v) => v.stock.damaged),
    };
  };

  return (
    <QueryBoundary {...query} refetch={() => query.refetch()} label="Loading product">
      {product && (
        <Stack gap={5}>
          <PageHeader
            title={product.name}
            breadcrumbs={[{ label: 'Products', href: '/products' }, { label: product.name }]}
            badges={
              product.status === 'ACTIVE' ? (
                <StockStatusBadge status={productStockStatus(product)} />
              ) : (
                <Badge dot>Archived</Badge>
              )
            }
            actions={
              <>
                {can('catalog:write') && (
                  <Button variant="secondary" icon="edit" onPress={() => setEditing(true)}>
                    Edit
                  </Button>
                )}
                {can('catalog:write') && (
                  <Button
                    variant={product.status === 'ACTIVE' ? 'danger' : 'secondary'}
                    onPress={() =>
                      product.status === 'ACTIVE'
                        ? setArchiving({ kind: 'product' })
                        : changeArchived({ kind: 'product' }, false)
                    }
                  >
                    {product.status === 'ACTIVE' ? 'Archive' : 'Restore'}
                  </Button>
                )}
              </>
            }
          />
          {product.status === 'ARCHIVED' && (
            <Alert tone="info">
              This product is archived: it is hidden from the default list and its stock cannot
              change.
            </Alert>
          )}
          <Split
            main={
              <>
                <Section
                  title="Variants"
                  description="Price and stock live on each variant."
                  actions={
                    can('catalog:write') && product.status === 'ACTIVE' ? (
                      <Button
                        variant="secondary"
                        icon="plus"
                        onPress={() => setVariantDialog({ variant: null })}
                      >
                        Add variant
                      </Button>
                    ) : undefined
                  }
                >
                  <DataTable
                    label="Variants"
                    columns={columns(product)}
                    rows={product.variants}
                    rowKey={(v) => v.id}
                    renderCard={(v) => (
                      <Stack gap={3}>
                        <Row justify="between" align="start" gap={2}>
                          {skuCell(v)}
                          <Text variant="label" numeric>
                            {formatPrice(v.priceMinor)}
                          </Text>
                        </Row>
                        <Row gap={4} wrap>
                          {(
                            [
                              ['On hand', v.stock.onHand],
                              ['Reserved', v.stock.reserved],
                              ['Available', v.stock.available],
                              ['Damaged', v.stock.damaged],
                            ] as const
                          ).map(([label, n]) => (
                            <Stack key={label} gap={1}>
                              <Text variant="caption" tone="muted">
                                {label}
                              </Text>
                              <Text numeric>{String(n)}</Text>
                            </Stack>
                          ))}
                        </Row>
                        {!v.archived && <StockStatusBadge status={variantStockStatus(v)} />}
                        {actions(product, v)}
                      </Stack>
                    )}
                  />
                </Section>
                <Section title="Details">
                  <KeyValueList
                    items={[
                      { label: 'Description', value: product.description ?? 'None' },
                      {
                        label: 'Category',
                        value: product.categoryId
                          ? (categories.data?.find((c) => c.id === product.categoryId)?.name ?? '—')
                          : 'None',
                      },
                      { label: 'Unit of measure', value: product.unit },
                      {
                        label: 'Supplier',
                        value: product.supplierId
                          ? (suppliers.data?.find((s) => s.id === product.supplierId)?.name ?? '—')
                          : 'None',
                      },
                    ]}
                  />
                  {product.imageUrls.length > 0 && (
                    <Row gap={2} wrap>
                      {product.imageUrls.map((url, i) => (
                        <Image
                          key={url}
                          source={{ uri: url }}
                          accessibilityLabel={`${product.name}, picture ${i + 1}`}
                          style={{ width: 96, height: 96, borderRadius: 8 }}
                          resizeMode="cover"
                        />
                      ))}
                    </Row>
                  )}
                </Section>
              </>
            }
            aside={
              <Card variant="outlined" padding="md">
                <Stack gap={3}>
                  <Text variant="title" role="heading" aria-level={2}>
                    Stock summary
                  </Text>
                  <KeyValueList
                    layout="inline"
                    items={[
                      { label: 'Price', value: priceRange(product) },
                      { label: 'On hand', value: String(totals(product).onHand) },
                      { label: 'Reserved', value: String(totals(product).reserved) },
                      { label: 'Damaged', value: String(totals(product).damaged) },
                      {
                        label: 'Available',
                        value: String(totals(product).available),
                        emphasis: true,
                      },
                    ]}
                  />
                </Stack>
              </Card>
            }
          />

          <ProductEditDialog product={product} open={editing} onClose={() => setEditing(false)} />
          <VariantDialog
            productId={product.id}
            variant={variantDialog?.variant ?? null}
            open={variantDialog !== null}
            onClose={() => setVariantDialog(null)}
          />
          <StockDialog
            mode={stock?.mode ?? 'receive'}
            variant={stock?.variant ?? null}
            onClose={() => setStock(null)}
          />
          <ConfirmDialog
            open={archiving !== null}
            title={
              archiving?.kind === 'product' ? 'Archive this product?' : 'Archive this variant?'
            }
            confirmLabel="Archive"
            danger
            busy={busy}
            onClose={() => setArchiving(null)}
            onConfirm={() => archiving && changeArchived(archiving, true)}
          >
            {archiving?.kind === 'product'
              ? 'It disappears from the default product list and stock can no longer change. You can restore it later.'
              : 'Its stock can no longer change. You can restore it later.'}
          </ConfirmDialog>
        </Stack>
      )}
    </QueryBoundary>
  );
}
