import type { Product, Variant } from '@orderloop/contracts';
import { Badge, type Tone } from '@orderloop/ui';

export type StockLevel = 'in' | 'low' | 'critical' | 'out' | 'archived';

export interface StockStatus {
  level: StockLevel;
  label: string;
  tone: Tone;
  /** Units available (the lowest variant's when a product has several). */
  available: number;
}

/** At or below half the reorder point (and at least one unit away from empty) counts as critical. */
const criticalAt = (reorderPoint: number) => Math.max(1, Math.floor(reorderPoint / 2));

/** The status of one stocked line: out of stock, critical, low (at or below its reorder point) or fine. */
export function stockStatus(available: number, reorderPoint: number): StockStatus {
  if (available <= 0) return { level: 'out', label: 'Out of stock', tone: 'error', available };
  if (reorderPoint > 0 && available <= reorderPoint) {
    if (available <= criticalAt(reorderPoint))
      return { level: 'critical', label: `Critical · ${available} left`, tone: 'error', available };
    return { level: 'low', label: 'Low stock', tone: 'warning', available };
  }
  return { level: 'in', label: 'In stock', tone: 'success', available };
}

/** What a product's stock says as a whole: out when nothing is available, otherwise its worst variant. */
export function productStockStatus(product: Product): StockStatus {
  const live = product.variants.filter((v) => !v.archived);
  const total = live.reduce((n, v) => n + v.stock.available, 0);
  if (live.length === 0 || total <= 0) return stockStatus(0, 0);
  const worst = live
    .map((v) => stockStatus(v.stock.available, v.reorderPoint))
    .filter((s) => s.level !== 'in' && s.level !== 'out')
    .sort((a, b) => a.available - b.available)[0];
  return worst ?? stockStatus(total, 0);
}

export const variantStockStatus = (v: Variant) => stockStatus(v.stock.available, v.reorderPoint);

/** A dot badge with the stock state in words (never colour alone). */
export function StockStatusBadge({ status }: { status: StockStatus }) {
  return (
    <Badge tone={status.tone} dot>
      {status.label}
    </Badge>
  );
}
