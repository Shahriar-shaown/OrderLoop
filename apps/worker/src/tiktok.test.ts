import { describe, expect, it, vi } from 'vitest';
import {
  TIKTOK_PURGE_EVERY_MS,
  TIKTOK_SCHEDULES,
  TIKTOK_STALE_RECEIVED_SECONDS,
  sweepReceivedTikTokEvents,
} from '@orderloop/automation';
import { onTikTokEventJobFailed, registerTikTokSchedules, tiktokProcessors } from './tiktok.js';
import { createWorkerMetrics } from './worker-metrics.js';

const ids = {
  tenantId: '11111111-1111-4111-8111-111111111111',
  eventId: '22222222-2222-4222-8222-222222222222',
};
const job = (data: unknown, over: object = {}) => ({
  id: 'j',
  name: 'event',
  data,
  opts: { attempts: 5 },
  ...over,
});

describe('registerTikTokSchedules', () => {
  it('registers the catch-up check, the token renewal and the health check, each by a fixed id, so several workers still make one of each', async () => {
    const upsertJobScheduler = vi.fn().mockResolvedValue(undefined);
    await registerTikTokSchedules({ upsertJobScheduler });
    await registerTikTokSchedules({ upsertJobScheduler });
    const calls = upsertJobScheduler.mock.calls.slice(0, 3);
    expect(calls.map((c) => [c[0], c[1], c[2].name])).toEqual([
      ['tiktok-sync', { every: 10 * 60_000 }, 'sync'],
      ['tiktok-refresh', { every: 15 * 60_000 }, 'refresh'],
      ['tiktok-health', { every: 24 * 3600_000 }, 'health'],
    ]);
    expect(upsertJobScheduler).toHaveBeenCalledTimes(6);
    expect(Object.keys(TIKTOK_SCHEDULES)).toEqual(['sync', 'refresh', 'health']);
  });
});

describe('tiktokProcessors', () => {
  const withContext = vi.fn();
  const process = {
    db: { withContext } as never,
    log: vi.fn(),
    now: () => new Date(),
    sink: {} as never,
  };

  it('re-validates the job: a malformed one is rejected and nothing touches the database', async () => {
    const p = tiktokProcessors({ process });
    await expect(p.event(job({ tenantId: 'nope', eventId: ids.eventId }))).rejects.toThrow();
    await expect(p.event(job({}))).rejects.toThrow();
    expect(withContext).not.toHaveBeenCalled();
  });

  it('runs the event in the business named by the job', async () => {
    const calls: unknown[] = [];
    const db = {
      withContext: async (ctx: unknown) => {
        calls.push(ctx);
        return null; // no such event: nothing to do
      },
    };
    await tiktokProcessors({ process: { ...process, db: db as never } }).event(job(ids));
    expect(calls).toEqual([{ tenantId: ids.tenantId }]);
  });

  it('the maintenance jobs do nothing without a live TikTok app, and run the right sweep when there is one', async () => {
    await expect(
      tiktokProcessors({ process }).maintenance(job({}, { name: 'sync' })),
    ).resolves.toBeUndefined();
    const liveTikTokConnections = vi.fn().mockResolvedValue([]);
    const tiktokConnectionsDueForRefresh = vi.fn().mockResolvedValue([]);
    const live = {
      db: { liveTikTokConnections, tiktokConnectionsDueForRefresh },
      client: {},
      vault: {},
      log: vi.fn(),
      now: () => new Date(),
      sink: {},
    } as never;
    const p = tiktokProcessors({ process, live });
    await p.maintenance(job({}, { name: 'sync' }));
    expect(liveTikTokConnections).toHaveBeenCalledTimes(1);
    await p.maintenance(job({}, { name: 'health' }));
    expect(liveTikTokConnections).toHaveBeenCalledTimes(2);
    await p.maintenance(job({}, { name: 'refresh' }));
    expect(tiktokConnectionsDueForRefresh).toHaveBeenCalledTimes(1);
    await p.maintenance(job({}, { name: 'unknown' }));
    expect(liveTikTokConnections).toHaveBeenCalledTimes(2);
  });
});

describe('onTikTokEventJobFailed', () => {
  it('marks the event failed only when the retries are used up, and logs no content', async () => {
    const updateMany = vi.fn().mockResolvedValue({ count: 1 });
    const db = {
      withContext: async (_c: unknown, fn: (tx: unknown) => unknown) =>
        fn({ tikTokEvent: { updateMany } }),
    } as never;
    const log = vi.fn();
    await onTikTokEventJobFailed(db, log, job(ids, { attemptsMade: 2 }), new Error('boom'));
    expect(updateMany).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith(
      expect.objectContaining({ outcome: 'will_retry', event: 'tiktok.job_failed' }),
    );
    await onTikTokEventJobFailed(db, log, job(ids, { attemptsMade: 5 }), new Error('boom'));
    expect(updateMany).toHaveBeenCalledWith({
      where: { id: ids.eventId, tenantId: ids.tenantId, status: 'received' },
      data: expect.objectContaining({ status: 'failed', error: 'processing_failed' }),
    });
    expect(JSON.stringify(log.mock.calls)).not.toContain('boom');
    // a job that is not ours (malformed data) marks nothing
    updateMany.mockClear();
    await onTikTokEventJobFailed(db, log, job({ junk: true }, { attemptsMade: 5 }), new Error('x'));
    expect(updateMany).not.toHaveBeenCalled();
  });
});

describe('sweepReceivedTikTokEvents', () => {
  const stale = (n: number) => ({
    id: `2222222${n}-2222-4222-8222-222222222222`,
    tenantId: ids.tenantId,
  });
  it('queues each stored-but-unprocessed event under an id derived from the event, so again is a no-op', async () => {
    const staleReceivedTikTokEvents = vi.fn().mockResolvedValue([stale(1), stale(2)]);
    const add = vi.fn().mockResolvedValue(undefined);
    const n = await sweepReceivedTikTokEvents({
      db: { staleReceivedTikTokEvents } as never,
      queue: { add },
      log: vi.fn(),
    });
    expect(n).toBe(2);
    expect(staleReceivedTikTokEvents).toHaveBeenCalledWith(TIKTOK_STALE_RECEIVED_SECONDS);
    expect(add).toHaveBeenCalledWith(
      'event',
      { tenantId: ids.tenantId, eventId: stale(1).id },
      expect.objectContaining({ jobId: `tiktok-event__${stale(1).id}`, attempts: 5 }),
    );
  });
  it('counts only what was really queued (Redis down: they stay for the next sweep)', async () => {
    const add = vi.fn().mockRejectedValue(new Error('redis down'));
    expect(
      await sweepReceivedTikTokEvents({
        db: { staleReceivedTikTokEvents: async () => [stale(1)] } as never,
        queue: { add },
        log: vi.fn(),
      }),
    ).toBe(0);
  });
  it('purges hourly', () => expect(TIKTOK_PURGE_EVERY_MS).toBe(3_600_000));
});

describe('the worker’s TikTok counters', () => {
  it('have fixed label sets: events by result, renewals and reconciliations by outcome, and never an id', async () => {
    const m = createWorkerMetrics({
      redis: { ping: async () => 'PONG' },
      db: { ping: async () => undefined },
      lastHeartbeatAt: () => new Date(),
    });
    m.tiktok.event('processed');
    m.tiktok.event('processed');
    m.tiktok.event('failed');
    m.tiktok.refresh('refreshed');
    m.tiktok.refresh('needs_reconnect');
    m.tiktok.reconcile('reserved');
    m.tiktok.reconcile('stock_short');
    const text = await m.registry.render();
    m.stop();
    const series = text
      .split('\n')
      .filter((l) => l.startsWith('orderloop_tiktok_') && !l.startsWith('#'));
    expect(series.sort()).toEqual([
      'orderloop_tiktok_events_total{result="failed"} 1',
      'orderloop_tiktok_events_total{result="processed"} 2',
      'orderloop_tiktok_reconcile_total{outcome="reserved"} 1',
      'orderloop_tiktok_reconcile_total{outcome="stock_short"} 1',
      'orderloop_tiktok_token_refresh_total{outcome="needs_reconnect"} 1',
      'orderloop_tiktok_token_refresh_total{outcome="refreshed"} 1',
    ]);
    expect(text).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-|mock_|shop_id|order_id/);
  });
});
