/**
 * What the TikTok code reports. Every value is from a short fixed set: NO shop id, order id, business or token ever becomes a
 * label (the registry also caps the number of label combinations). The API and the worker each provide their own counters.
 */
export type TikTokEventResult =
  | 'stored'
  | 'duplicate'
  | 'ignored'
  | 'unknown_shop'
  | 'bad_signature'
  | 'queue_failed'
  | 'processed'
  | 'already'
  | 'failed';
export type TikTokRefreshOutcome =
  'refreshed' | 'skipped' | 'locked' | 'failed' | 'needs_reconnect' | 'permission_error';
export type TikTokReconcileOutcome =
  'reserved' | 'shipped' | 'released' | 'needs_mapping' | 'stock_short' | 'unchanged' | 'attention';

export interface TikTokMetrics {
  event(result: TikTokEventResult): void;
  refresh(outcome: TikTokRefreshOutcome): void;
  reconcile(outcome: TikTokReconcileOutcome): void;
}

export const noopTikTokMetrics: TikTokMetrics = {
  event: () => undefined,
  refresh: () => undefined,
  reconcile: () => undefined,
};

/** The slice of the observability registry the counters need (so this package stays free of that dependency). */
export interface CounterRegistry {
  counter(options: { name: string; help: string; labelNames: string[] }): {
    inc(labels: Record<string, string>, by?: number): void;
  };
}

/**
 * The three TikTok counters on a registry: events by result, token renewals by outcome, stock reconciliations by outcome. The
 * label sets are the fixed unions above and nothing else, so the series count is bounded and no id can leak into a label.
 */
export function createTikTokMetrics(registry: CounterRegistry): TikTokMetrics {
  const events = registry.counter({
    name: 'orderloop_tiktok_events_total',
    help: 'TikTok Shop events by result: stored, duplicate, ignored, unknown_shop, bad_signature, queue_failed (API) and processed, already, failed (worker)',
    labelNames: ['result'],
  });
  const refreshes = registry.counter({
    name: 'orderloop_tiktok_token_refresh_total',
    help: 'TikTok token renewals by outcome (refreshed, failed, needs_reconnect, permission_error, locked, skipped)',
    labelNames: ['outcome'],
  });
  const reconciles = registry.counter({
    name: 'orderloop_tiktok_reconcile_total',
    help: 'TikTok order stock reconciliations by outcome (reserved, shipped, released, needs_mapping, stock_short, unchanged, attention)',
    labelNames: ['outcome'],
  });
  return {
    event: (result) => events.inc({ result }),
    refresh: (outcome) => refreshes.inc({ outcome }),
    reconcile: (outcome) => reconciles.inc({ outcome }),
  };
}
