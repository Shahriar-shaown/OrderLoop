import type { Product } from '@orderloop/contracts';
import { Card, Icon, Link, Row, Stack, Text, useTheme, type IconName } from '@orderloop/ui';
import type { ReactNode } from 'react';
import { View } from 'react-native';
import { formatPrice } from '../money';
import { productStockStatus, StockStatusBadge } from './StockStatusBadge';

/** "৳650" or "৳650 – ৳990" over a product's live variants. */
export function priceRange(p: Product): string {
  const prices = p.variants.filter((v) => !v.archived).map((v) => v.priceMinor);
  if (prices.length === 0) return '—';
  const lo = Math.min(...prices);
  const hi = Math.max(...prices);
  return lo === hi ? formatPrice(lo) : `${formatPrice(lo)} – ${formatPrice(hi)}`;
}

/** Cost price(s), or null when any live variant has no cost recorded. */
export function costRange(p: Product): string | null {
  const live = p.variants.filter((v) => !v.archived);
  if (live.length === 0 || live.some((v) => v.costMinor === null)) return null;
  const costs = live.map((v) => v.costMinor as number);
  const lo = Math.min(...costs);
  const hi = Math.max(...costs);
  return lo === hi ? formatPrice(lo) : `${formatPrice(lo)} – ${formatPrice(hi)}`;
}

/** Margin on price, "34.6%", or "34.6–38.5%" over variants; null when any live variant has no cost. */
export function marginRange(p: Product): string | null {
  const live = p.variants.filter((v) => !v.archived);
  if (live.length === 0 || live.some((v) => v.costMinor === null || v.priceMinor <= 0)) return null;
  const m = live.map((v) => ((v.priceMinor - (v.costMinor as number)) / v.priceMinor) * 100);
  const lo = Math.min(...m).toFixed(1);
  const hi = Math.max(...m).toFixed(1);
  return lo === hi ? `${lo}%` : `${lo}–${hi}%`;
}

export const stockCount = (p: Product) =>
  p.variants.filter((v) => !v.archived).reduce((n, v) => n + v.stock.available, 0);

/** The SKU line under a product name: the first SKU, and how many more variants there are. */
export function skuSummary(p: Product): string {
  const live = p.variants.filter((v) => !v.archived);
  const first = (live[0] ?? p.variants[0])?.sku ?? '';
  return live.length > 1 ? `${first} +${live.length - 1} variants` : first;
}

/** The small square with a tag (the design's product thumbnail). */
export function ProductThumb({ icon = 'tag' }: { icon?: IconName }) {
  const { colors } = useTheme();
  return (
    <View
      style={{
        width: 36,
        height: 36,
        borderRadius: 8,
        backgroundColor: colors.subtle,
        alignItems: 'center',
        justifyContent: 'center',
      }}
    >
      <Icon name={icon} size={16} color={colors.muted} />
    </View>
  );
}

/**
 * One product as a card: used in the grid view and, without its own frame (`bare`), as a table row on a phone. `menu` is the
 * row actions menu.
 */
export function ProductCard({
  product,
  categoryName,
  menu,
  bare = false,
}: {
  product: Product;
  categoryName?: string | undefined;
  menu?: ReactNode;
  bare?: boolean;
}) {
  const archived = product.status === 'ARCHIVED';
  const body = (
    <Stack gap={3}>
      <Row gap={3} align="start" justify="between">
        <Row gap={3} align="center" style={{ flexShrink: 1, minWidth: 0 }}>
          <ProductThumb />
          <Stack gap={1} style={{ flexShrink: 1 }}>
            <Link href={`/products/${product.id}`} weight="medium">
              {product.name}
            </Link>
            <Text variant="caption" tone="muted">
              {skuSummary(product)}
            </Text>
          </Stack>
        </Row>
        {menu}
      </Row>
      <Row gap={3} justify="between" wrap>
        <Stack gap={1}>
          <Text variant="label" numeric>
            {priceRange(product)}
          </Text>
          {categoryName ? (
            <Text variant="caption" tone="muted">
              {categoryName}
            </Text>
          ) : null}
        </Stack>
        <Stack gap={1} align="end">
          {archived ? <Text tone="muted">Archived</Text> : null}
          {!archived && <StockStatusBadge status={productStockStatus(product)} />}
          <Text variant="caption" tone="muted" numeric>
            {`${stockCount(product)} ${product.unit} in stock`}
          </Text>
        </Stack>
      </Row>
    </Stack>
  );
  return bare ? (
    body
  ) : (
    <Card variant="outlined" padding="md">
      {body}
    </Card>
  );
}
