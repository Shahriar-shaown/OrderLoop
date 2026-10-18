import type { Product, Variant } from '@orderloop/contracts';
import { Button, Row, Stack, Text, TextField } from '@orderloop/ui';
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { variantLabel } from '../format';
import { useDebounced } from '../hooks';
import { formatPrice } from '../money';
import { useApi } from '../runtime';

export interface PickedVariant {
  id: string;
  sku: string;
  label: string;
  priceMinor: number;
  available: number;
}

/** Search the catalog and pick a variant to put on an order. Only sellable (active) variants are offered. */
export function VariantPicker({
  onPick,
  disabledIds = [],
}: {
  onPick: (v: PickedVariant) => void;
  disabledIds?: string[];
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
      <TextField
        label="Add an item"
        kind="search"
        placeholder="Search products by name or SKU"
        value={search}
        onChangeText={setSearch}
        hint="Type at least 2 letters."
      />
      {q.length >= 2 && !results.isPending && options.length === 0 && (
        <Text tone="muted">No products match “{q}”.</Text>
      )}
      {options.map(({ product, variant }) => (
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
            disabled={disabledIds.includes(variant.id)}
            onPress={() => {
              onPick({
                id: variant.id,
                sku: variant.sku,
                label: variantLabel(product.name, variant.name),
                priceMinor: variant.priceMinor,
                available: variant.stock.available,
              });
              setSearch('');
            }}
          >
            {disabledIds.includes(variant.id) ? 'Added' : 'Add'}
          </Button>
        </Row>
      ))}
    </Stack>
  );
}
