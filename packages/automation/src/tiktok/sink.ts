import type { Tx } from '@orderloop/db';
import type { TikTokApplyInput, TikTokApplyResult } from '@orderloop/domain';
import type { TikTokMetrics } from './metrics.js';

/**
 * What the pollers and the worker use to put an order into the mirror and move the stock. Implemented in packages/catalog (the
 * only code that changes stock) and handed in, because this package may not depend on it: `applyTikTokOrder`,
 * `reconcileTikTokOrder` and `waitingTikTokOrders` there. Every method runs inside the caller's transaction and is safe to repeat.
 */
export interface TikTokOrderSink {
  /** Upsert (never backwards), link SKUs, then reconcile the stock. */
  apply(tx: Tx, input: TikTokApplyInput): Promise<TikTokApplyResult>;
  /** Run the stock rules again for one stored order (a SKU was mapped, stock arrived). */
  reconcile(tx: Tx, ref: { tenantId: string; orderId: string }): Promise<TikTokApplyResult>;
  /** Ids of this connection's orders that are waiting (`needs_mapping`, `stock_short`) for a person or for stock. */
  waiting(
    tx: Tx,
    ref: { tenantId: string; connectionId: string; limit: number },
  ): Promise<string[]>;
}

/** Report what a call did to the stock, as one low-cardinality outcome. */
export function reportApply(metrics: TikTokMetrics, r: TikTokApplyResult): void {
  if (r.shipped > 0) metrics.reconcile('shipped');
  else if (r.reserved > 0) metrics.reconcile('reserved');
  else if (r.released > 0) metrics.reconcile('released');
  else if (r.stockState === 'needs_mapping') metrics.reconcile('needs_mapping');
  else if (r.stockState === 'stock_short') metrics.reconcile('stock_short');
  else metrics.reconcile('unchanged');
  if (r.attention) metrics.reconcile('attention');
}
