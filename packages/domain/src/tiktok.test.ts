import { describe, expect, it } from 'vitest';
import {
  currencyExponent,
  effectiveTikTokStatus,
  isNewerTikTokSnapshot,
  normalizeTikTokStatus,
  parseMinorUnits,
  planTikTokStock,
  tikTokExpiry,
  tikTokRefreshBackoffMs,
  tikTokRefreshDue,
  tikTokRefreshWindowMs,
  tikTokStockIntent,
  TIKTOK_STATUSES,
  type TikTokHoldState,
  type TikTokReconcileLine,
} from './tiktok.js';

const line = (
  key: string,
  quantity: number,
  variantId: string | null,
  hold: TikTokHoldState | null = null,
): TikTokReconcileLine => ({ key, quantity, variantId, hold });
const avail = (o: Record<string, number>) => new Map(Object.entries(o));

describe('statuses', () => {
  it('normalises spelling and blanks', () => {
    expect(normalizeTikTokStatus(' awaiting-shipment ')).toBe('AWAITING_SHIPMENT');
    expect(normalizeTikTokStatus('')).toBe('UNKNOWN');
    expect(normalizeTikTokStatus(null)).toBe('UNKNOWN');
  });
  it('treats an order inside the buyer hold as ON_HOLD, whatever the status text says', () => {
    expect(effectiveTikTokStatus('AWAITING_SHIPMENT', true)).toBe('ON_HOLD');
    expect(effectiveTikTokStatus('AWAITING_SHIPMENT', false)).toBe('AWAITING_SHIPMENT');
    expect(effectiveTikTokStatus('IN_TRANSIT', true)).toBe('IN_TRANSIT');
  });
});

describe('status monotonicity', () => {
  const t = (s: string) => new Date(`2026-10-22T10:00:${s}Z`);
  it('accepts anything when nothing is stored', () => {
    expect(isNewerTikTokSnapshot(null, { status: 'UNPAID', updatedAt: t('00') })).toBe(true);
    expect(
      isNewerTikTokSnapshot(
        { status: 'UNPAID', updatedAt: null },
        { status: 'UNPAID', updatedAt: t('00') },
      ),
    ).toBe(true);
  });
  it('TikTok update time decides, not arrival order', () => {
    const stored = { status: 'IN_TRANSIT', updatedAt: t('30') };
    expect(isNewerTikTokSnapshot(stored, { status: 'AWAITING_SHIPMENT', updatedAt: t('10') })).toBe(
      false,
    );
    expect(isNewerTikTokSnapshot(stored, { status: 'DELIVERED', updatedAt: t('40') })).toBe(true);
  });
  it('a tie goes to the further-along status', () => {
    const stored = { status: 'IN_TRANSIT', updatedAt: t('30') };
    expect(isNewerTikTokSnapshot(stored, { status: 'AWAITING_SHIPMENT', updatedAt: t('30') })).toBe(
      false,
    );
    expect(isNewerTikTokSnapshot(stored, { status: 'DELIVERED', updatedAt: t('30') })).toBe(true);
    expect(isNewerTikTokSnapshot(stored, { status: 'IN_TRANSIT', updatedAt: t('30') })).toBe(true);
  });
});

describe('money', () => {
  it('parses decimal strings exactly, per currency exponent', () => {
    expect(parseMinorUnits('12.50', 2)).toBe(1250n);
    expect(parseMinorUnits('12', 2)).toBe(1200n);
    expect(parseMinorUnits('0.1', 2)).toBe(10n);
    expect(parseMinorUnits('1500', 0)).toBe(1500n);
    expect(parseMinorUnits('1.2345', 3)).toBe(1235n); // half up
    expect(parseMinorUnits('0.005', 2)).toBe(1n);
    expect(parseMinorUnits('0.004', 2)).toBe(0n);
    expect(parseMinorUnits('123456789012.34', 2)).toBe(12345678901234n);
    expect(parseMinorUnits(19.99, 2)).toBe(1999n);
  });
  it('refuses what is not a plain non-negative decimal', () => {
    for (const bad of ['', ' ', '-1', '1e3', 'abc', '1,5', null, undefined, '1.', '.5'])
      expect(parseMinorUnits(bad as never, 2), String(bad)).toBeNull();
  });
  it('knows the exponent of the currencies it meets', () => {
    expect(currencyExponent('MYR')).toBe(2);
    expect(currencyExponent('jpy')).toBe(0);
    expect(currencyExponent('VND')).toBe(0);
    expect(currencyExponent('KWD')).toBe(3);
    expect(currencyExponent(null)).toBe(2);
  });
});

describe('token expiry maths', () => {
  const now = new Date('2026-10-22T00:00:00Z');
  it('reads a Unix timestamp or a number of seconds', () => {
    expect(tikTokExpiry(1_792_000_000, now)?.toISOString()).toBe(
      new Date(1_792_000_000_000).toISOString(),
    );
    expect(tikTokExpiry(86_400, now)?.toISOString()).toBe('2026-10-23T00:00:00.000Z');
    expect(tikTokExpiry('86400', now)?.toISOString()).toBe('2026-10-23T00:00:00.000Z');
    expect(tikTokExpiry(0, now)).toBeNull();
    expect(tikTokExpiry(undefined, now)).toBeNull();
    expect(tikTokExpiry('soon', now)).toBeNull();
  });
  it('renews at half the lifetime, between 10 minutes and 24 hours', () => {
    expect(tikTokRefreshWindowMs(10 * 86_400_000)).toBe(24 * 3600_000);
    expect(tikTokRefreshWindowMs(86_400_000)).toBe(12 * 3600_000);
    expect(tikTokRefreshWindowMs(60_000)).toBe(10 * 60_000);
    expect(tikTokRefreshWindowMs(null)).toBe(24 * 3600_000);
  });
  it('is due inside the window, on an unknown expiry, or when the refresh token is the one running out', () => {
    const obtained = new Date('2026-10-20T00:00:00Z');
    const far = new Date('2026-11-30T00:00:00Z');
    expect(
      tikTokRefreshDue(now, {
        obtainedAt: obtained,
        accessExpiresAt: new Date('2026-10-30T00:00:00Z'),
        refreshExpiresAt: far,
      }),
    ).toBe(false);
    expect(
      tikTokRefreshDue(now, {
        obtainedAt: obtained,
        accessExpiresAt: new Date('2026-10-22T10:00:00Z'),
        refreshExpiresAt: far,
      }),
    ).toBe(true);
    expect(
      tikTokRefreshDue(now, { obtainedAt: obtained, accessExpiresAt: null, refreshExpiresAt: far }),
    ).toBe(true);
    expect(
      tikTokRefreshDue(now, {
        obtainedAt: obtained,
        accessExpiresAt: new Date('2026-12-30T00:00:00Z'),
        refreshExpiresAt: new Date('2026-10-22T06:00:00Z'),
      }),
    ).toBe(true);
  });
  it('backs off 15 minutes, doubling, to at most 6 hours', () => {
    expect([1, 2, 3, 4, 5, 6, 10].map(tikTokRefreshBackoffMs)).toEqual([
      900_000, 1_800_000, 3_600_000, 7_200_000, 14_400_000, 21_600_000, 21_600_000,
    ]);
  });
});

describe('stock intent by status', () => {
  it('maps every documented status', () => {
    const intents = Object.fromEntries(TIKTOK_STATUSES.map((s) => [s, tikTokStockIntent(s)]));
    expect(intents).toEqual({
      UNPAID: 'none',
      ON_HOLD: 'none',
      AWAITING_SHIPMENT: 'reserve',
      PARTIALLY_SHIPPING: 'reserve',
      AWAITING_COLLECTION: 'reserve',
      IN_TRANSIT: 'ship',
      DELIVERED: 'ship',
      COMPLETED: 'ship',
      CANCELLED: 'release',
    });
    expect(tikTokStockIntent('SOMETHING_NEW')).toBe('none');
  });
});

describe('the reconciler rules table', () => {
  const A = 'var-a';
  const B = 'var-b';
  const plan = (
    status: string,
    lines: TikTokReconcileLine[],
    available: Record<string, number> = { [A]: 10, [B]: 10 },
    onHold = false,
  ) => planTikTokStock({ status, onHold, lines, available: avail(available) });

  it.each(['UNPAID', 'ON_HOLD', 'UNKNOWN'])(
    '%s: no stock effect, even with unmapped lines',
    (status) => {
      const p = plan(status, [line('sku:1', 1, null), line('sku:2', 1, A)]);
      expect(p.actions).toEqual([]);
      expect(p.stockState).toBe('none');
      expect(p.blocked).toBeNull();
    },
  );

  it('an order on hold reserves nothing even when the status text says awaiting shipment', () => {
    expect(plan('AWAITING_SHIPMENT', [line('sku:1', 1, A)], undefined, true).actions).toEqual([]);
  });

  it.each(['AWAITING_SHIPMENT', 'AWAITING_COLLECTION', 'PARTIALLY_SHIPPING'])(
    '%s reserves each unreserved line once',
    (status) => {
      const p = plan(status, [line('sku:1', 2, A), line('sku:2', 1, B)]);
      expect(p.actions).toEqual([
        { key: 'sku:1', action: 'reserve' },
        { key: 'sku:2', action: 'reserve' },
      ]);
      expect(p.stockState).toBe('reserved');
    },
  );

  it('planning again after the holds exist plans nothing (retry, duplicate, replay)', () => {
    const p = plan('AWAITING_SHIPMENT', [line('sku:1', 2, A, 'held'), line('sku:2', 1, B, 'held')]);
    expect(p.actions).toEqual([]);
    expect(p.stockState).toBe('reserved');
  });

  it('IN_TRANSIT / DELIVERED / COMPLETED ship what is held', () => {
    for (const status of ['IN_TRANSIT', 'DELIVERED', 'COMPLETED']) {
      const p = plan(status, [line('sku:1', 2, A, 'held')]);
      expect(p.actions).toEqual([{ key: 'sku:1', action: 'ship' }]);
      expect(p.stockState).toBe('shipped');
    }
  });

  it('shipping twice plans nothing the second time', () => {
    const p = plan('DELIVERED', [line('sku:1', 2, A, 'shipped')]);
    expect(p.actions).toEqual([]);
    expect(p.stockState).toBe('shipped');
  });

  it('an order first seen late is reserved and shipped in one go, once', () => {
    const p = plan('IN_TRANSIT', [line('sku:1', 3, A)]);
    expect(p.actions).toEqual([{ key: 'sku:1', action: 'reserve_and_ship' }]);
    expect(p.stockState).toBe('shipped');
    expect(plan('IN_TRANSIT', [line('sku:1', 3, A, 'shipped')]).actions).toEqual([]);
  });

  it('a mix of held and never-reserved lines ships the held and reserves-and-ships the rest', () => {
    const p = plan('COMPLETED', [line('sku:1', 1, A, 'held'), line('sku:2', 1, B)]);
    expect(p.actions).toEqual([
      { key: 'sku:1', action: 'ship' },
      { key: 'sku:2', action: 'reserve_and_ship' },
    ]);
  });

  it('CANCELLED before shipping releases what is held, once', () => {
    const p = plan('CANCELLED', [line('sku:1', 2, A, 'held'), line('sku:2', 1, B, 'held')]);
    expect(p.actions).toEqual([
      { key: 'sku:1', action: 'release' },
      { key: 'sku:2', action: 'release' },
    ]);
    expect(p.stockState).toBe('released');
    expect(p.attention).toBeNull();
    expect(plan('CANCELLED', [line('sku:1', 2, A, 'released')]).actions).toEqual([]);
  });

  it('CANCELLED with nothing ever reserved changes nothing and needs no mapping', () => {
    const p = plan('CANCELLED', [line('sku:1', 1, null)]);
    expect(p.actions).toEqual([]);
    expect(p.stockState).toBe('none');
    expect(p.blocked).toBeNull();
  });

  it('CANCELLED after shipping makes no automatic stock change and is flagged for a person', () => {
    const p = plan('CANCELLED', [line('sku:1', 1, A, 'shipped')]);
    expect(p.actions).toEqual([]);
    expect(p.attention).toBe('cancelled_after_shipping');
    expect(p.stockState).toBe('shipped');
  });

  it('any unmapped line holds the WHOLE order: no stock change at all until every line is mapped', () => {
    for (const status of ['AWAITING_SHIPMENT', 'IN_TRANSIT']) {
      const p = plan(status, [line('sku:1', 1, A), line('sku:2', 1, null)]);
      expect(p.actions).toEqual([]);
      expect(p.stockState).toBe('needs_mapping');
      expect(p.unmappedKeys).toEqual(['sku:2']);
    }
  });

  it('is all-or-nothing on stock: one short variant reserves nothing and nothing is oversold', () => {
    const p = plan('AWAITING_SHIPMENT', [line('sku:1', 2, A), line('sku:2', 5, B)], {
      [A]: 10,
      [B]: 4,
    });
    expect(p.actions).toEqual([]);
    expect(p.stockState).toBe('stock_short');
    expect(p.shortKeys).toEqual(['sku:2']);
  });

  it('adds up lines that share a variant before comparing with what is available', () => {
    const lines = [line('sku:1', 3, A), line('sku:2', 3, A)];
    expect(plan('AWAITING_SHIPMENT', lines, { [A]: 5 }).stockState).toBe('stock_short');
    expect(plan('AWAITING_SHIPMENT', lines, { [A]: 6 }).actions).toHaveLength(2);
  });

  it('a variant with no stock row counts as nothing available', () => {
    expect(plan('AWAITING_SHIPMENT', [line('sku:1', 1, A)], {}).stockState).toBe('stock_short');
  });

  it('shipping a held line is allowed even when the other lines are short or unmapped', () => {
    const p = plan('IN_TRANSIT', [line('sku:1', 1, A, 'held'), line('sku:2', 9, B)], {
      [A]: 0,
      [B]: 1,
    });
    expect(p.actions).toEqual([{ key: 'sku:1', action: 'ship' }]);
    expect(p.stockState).toBe('stock_short');
  });

  it('an order with no lines needs nothing', () => {
    expect(plan('AWAITING_SHIPMENT', []).stockState).toBe('none');
  });

  it('a released line is never reserved again, even if the status moves back', () => {
    const p = plan('AWAITING_SHIPMENT', [line('sku:1', 1, A, 'released')]);
    expect(p.actions).toEqual([]);
    expect(p.stockState).toBe('released');
  });
});

describe('the reconciler, every status against mapped or not, short or not, and a retry', () => {
  const A = 'var-a';
  /** What the database layer does with a plan: holds follow the actions. */
  const applied = (lines: TikTokReconcileLine[], plan: ReturnType<typeof planTikTokStock>) =>
    lines.map((l): TikTokReconcileLine => {
      const a = plan.actions.find((x) => x.key === l.key)?.action;
      if (a === 'reserve') return { ...l, hold: 'held' };
      if (a === 'ship' || a === 'reserve_and_ship') return { ...l, hold: 'shipped' };
      if (a === 'release') return { ...l, hold: 'released' };
      return l;
    });

  const statuses = [...TIKTOK_STATUSES, 'UNKNOWN'];
  for (const status of statuses)
    for (const mapped of [true, false])
      for (const enough of [true, false])
        for (const hold of [null, 'held', 'shipped', 'released'] as const)
          it(`${status}, ${mapped ? 'mapped' : 'unmapped'}, ${enough ? 'enough' : 'short'} stock, line already ${hold ?? 'untouched'}: one pass decides, a retry does nothing`, () => {
            const lines = [line('sku:1', 3, mapped || hold ? A : null, hold)];
            const input = (ls: TikTokReconcileLine[]) => ({
              status,
              onHold: false,
              lines: ls,
              available: avail({ [A]: enough ? 10 : 1 }),
            });
            const first = planTikTokStock(input(lines));
            const second = planTikTokStock(input(applied(lines, first)));
            // exactly-once: planning again after the effects were applied asks for nothing more
            expect(second.actions, 'retry').toEqual([]);
            // never an effect on a line that already had one for the same purpose
            for (const a of first.actions) {
              if (a.action === 'reserve' || a.action === 'reserve_and_ship')
                expect(hold).toBeNull();
              if (a.action === 'ship') expect(hold).toBe('held');
              if (a.action === 'release') expect(hold).toBe('held');
            }
            // blocked orders move nothing for new lines and say why
            if (first.blocked === 'needs_mapping') {
              expect(first.actions.filter((a) => a.action.startsWith('reserve'))).toEqual([]);
              expect(mapped).toBe(false);
              expect(hold).toBeNull();
            }
            if (first.blocked === 'stock_short') {
              expect(first.actions.filter((a) => a.action.startsWith('reserve'))).toEqual([]);
              expect(enough).toBe(false);
            }
            // nothing is ever reserved beyond what is available
            const reserved = first.actions
              .filter((a) => a.action === 'reserve' || a.action === 'reserve_and_ship')
              .reduce((n) => n + 3, 0);
            expect(reserved).toBeLessThanOrEqual(enough ? 10 : 1);
            // the state is one of the documented ones, and agrees with the plan
            expect([
              'none',
              'reserved',
              'shipped',
              'released',
              'needs_mapping',
              'stock_short',
            ]).toContain(first.stockState);
            if (first.blocked) expect(first.stockState).toBe(first.blocked);
          });
});
