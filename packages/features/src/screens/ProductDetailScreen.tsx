import type { Product, Variant } from '@orderloop/contracts';
import {
  Alert,
  Badge,
  Button,
  ConfirmDialog,
  DataTable,
  KeyValueList,
  PageHeader,
  Row,
  Section,
  Stack,
  Text,
  useToast,
  type Column,
} from '@orderloop/ui';
import { useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { ProductEditDialog } from '../components/ProductEditDialog';
import { QueryBoundary } from '../components/QueryBoundary';
import { StockDialog, type StockMode, type VariantRef } from '../components/StockDialog';
import { VariantDialog } from '../components/VariantDialog';
import { messageFor } from '../errors';
import { useCategories, useProduct } from '../hooks';
import { formatPrice } from '../money';
import { useCan } from '../permissions';
import { useApi } from '../runtime';
import { variantLabel } from '../format';

type Archiving = { kind: 'product' } | { kind: 'variant'; variant: Variant } | null;

export function ProductDetailScreen({ id }: { id: string }) {
  const api = useApi();
  const can = useCan();
  const toast = useToast();
  const queryClient = useQueryClient();
  const query = useProduct(id);
  const categories = useCategories();
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

  const ref = (p: Product, v: Variant): VariantRef => ({
    id: v.id,
    sku: v.sku,
    label: variantLabel(p.name, v.name),
  });

  const columns = (p: Product): Column<Variant>[] => [
    {
      key: 'sku',
      header: 'SKU',
      minWidth: 150,
      flex: 2,
      render: (v) => (
        <Stack gap={1}>
          <Text weight="bold">{v.sku}</Text>
          {v.name ? (
            <Text variant="caption" tone="muted">
              {v.name}
            </Text>
          ) : null}
          {v.archived ? <Badge>Archived</Badge> : null}
        </Stack>
      ),
    },
    { key: 'price', header: 'Price', minWidth: 110, render: (v) => formatPrice(v.priceMinor) },
    {
      key: 'onHand',
      header: 'On hand',
      align: 'right',
      minWidth: 90,
      render: (v) => String(v.stock.onHand),
    },
    {
      key: 'reserved',
      header: 'Reserved',
      align: 'right',
      minWidth: 90,
      render: (v) => String(v.stock.reserved),
    },
    {
      key: 'available',
      header: 'Available',
      align: 'right',
      minWidth: 100,
      render: (v) =>
        v.reorderPoint > 0 && v.stock.available <= v.reorderPoint ? (
          <Badge tone="warning">{`${v.stock.available} low`}</Badge>
        ) : (
          String(v.stock.available)
        ),
    },
    {
      key: 'actions',
      header: 'Actions',
      flex: 3,
      minWidth: 440,
      render: (v) => (
        <Row gap={1} wrap>
          {can('inventory:write') && !v.archived && (
            <>
              <Button
                size="sm"
                variant="secondary"
                onPress={() => setStock({ mode: 'receive', variant: ref(p, v) })}
              >
                Receive
              </Button>
              <Button
                size="sm"
                variant="secondary"
                onPress={() => setStock({ mode: 'adjust', variant: ref(p, v) })}
              >
                Adjust
              </Button>
              <Button
                size="sm"
                variant="secondary"
                onPress={() => setStock({ mode: 'reserve', variant: ref(p, v) })}
              >
                Reserve
              </Button>
            </>
          )}
          {can('catalog:write') && (
            <>
              <Button size="sm" variant="ghost" onPress={() => setVariantDialog({ variant: v })}>
                Edit
              </Button>
              <Button
                size="sm"
                variant="ghost"
                onPress={() =>
                  v.archived
                    ? changeArchived({ kind: 'variant', variant: v }, false)
                    : setArchiving({ kind: 'variant', variant: v })
                }
              >
                {v.archived ? 'Restore' : 'Archive'}
              </Button>
            </>
          )}
        </Row>
      ),
    },
  ];

  return (
    <QueryBoundary {...query} refetch={() => query.refetch()} label="Loading product">
      {product && (
        <Stack gap={5}>
          <PageHeader
            title={product.name}
            actions={
              <Row gap={2} wrap>
                <Badge tone={product.status === 'ACTIVE' ? 'success' : 'neutral'}>
                  {product.status === 'ACTIVE' ? 'Active' : 'Archived'}
                </Badge>
                <Button href="/products" variant="secondary">
                  Back to products
                </Button>
                {can('catalog:write') && (
                  <Button variant="secondary" onPress={() => setEditing(true)}>
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
              </Row>
            }
          />
          {product.status === 'ARCHIVED' && (
            <Alert tone="info">
              This product is archived: it is hidden from the default list and its stock cannot
              change.
            </Alert>
          )}
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
              ]}
            />
          </Section>
          <Section
            title="Variants"
            description="Price and stock live on each variant."
            actions={
              can('catalog:write') && product.status === 'ACTIVE' ? (
                <Button variant="secondary" onPress={() => setVariantDialog({ variant: null })}>
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
            />
          </Section>

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
