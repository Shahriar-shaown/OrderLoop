import type { Product, Variant } from '@orderloop/contracts';
import { Button, Card, Row, SearchField, Stack, Text } from '@orderloop/ui';
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { variantLabel } from '../../lib/format';
import { useDebounced } from '../../lib/hooks';
import { formatPrice } from '../../lib/money';
import { useApi } from '../../core/runtime';

export interface PickedVariant {
  id: string;
  sku: string;
  label: string;
  priceMinor: number;
  available: number;
  /** Stock level at which the variant is flagged as low. */
  reorderPoint: number;
  /** What one unit costs you, when you have entered it. */
  costMinor: number | null;
}

/** Search the catalog and pick a variant to put on an order. Only sellable (active) variants are offered. */
export function VariantPicker({
  onPick,
  disabledIds = [],
  label = 'Add an item',
  actionLabel = 'Add',
}: {
  onPick: (v: PickedVariant) => void;
  disabledIds?: string[];
  /** Names the search box (a second picker on the same page needs its own name). */
  label?: string;
  /** What the button beside each product says: "Add" on an order, "Use this product" when mapping a SKU. */
  actionLabel?: string;
}) {
  const api = useApi();
  const [search, setSearch] = useState('');
  const q = useDebounced(search.trim());
  const results = useQuery({
    queryKey: ['products', 'picker', q],
    queryFn: () => api.products.list({ limit: 8, status: 'ACTIVE', ...(q ? { q } : {}) }),
    enabled: q.length >= 2,
  });
  const options: { product: Product; variant: Variant }[] = (results.data?.items ?? []).flatMap(
    (p) => p.variants.filter((v) => !v.archived).map((variant) => ({ product: p, variant })),
  );
  return (
    <Stack gap={2}>
      <SearchField
        label={label}
        placeholder="Search product name or SKU"
        value={search}
        onChangeText={setSearch}
      />
      {q.length < 2 && (
        <Text variant="caption" tone="muted">
          Type at least 2 letters.
        </Text>
      )}
      {q.length >= 2 && !results.isPending && options.length === 0 && (
        <Text tone="muted">No products match “{q}”.</Text>
      )}
      {options.length > 0 && (
        <Card variant="outlined" padding="sm">
          <Stack gap={3}>
            {options.map(({ product, variant }) => {
              const added = disabledIds.includes(variant.id);
              return (
                <Row key={variant.id} gap={2} wrap justify="between">
                  <Stack gap={1} grow>
                    <Text weight="medium">{variantLabel(product.name, variant.name)}</Text>
                    <Text variant="caption" tone="muted">
                      {variant.sku} · {formatPrice(variant.priceMinor)} · {variant.stock.available}{' '}
                      available
                    </Text>
                  </Stack>
                  <Button
                    size="sm"
                    variant="secondary"
                    disabled={added}
                    onPress={() => {
                      onPick({
                        id: variant.id,
                        sku: variant.sku,
                        label: variantLabel(product.name, variant.name),
                        priceMinor: variant.priceMinor,
                        available: variant.stock.available,
                        reorderPoint: variant.reorderPoint,
                        costMinor: variant.costMinor,
                      });
                      setSearch('');
                    }}
                  >
                    {added ? 'Added' : actionLabel}
                  </Button>
                </Row>
              );
            })}
          </Stack>
        </Card>
      )}
    </Stack>
  );
}
