import { describe, expect, it, vi } from 'vitest';
import { metaProcessors, onEventJobFailed, registerHealthSchedule } from './meta.js';

const ids = {
  tenantId: '11111111-1111-4111-8111-111111111111',
  eventId: '22222222-2222-4222-8222-222222222222',
};
const job = (data: unknown, over: object = {}) => ({
  id: 'j',
  data,
  opts: { attempts: 5 },
  ...over,
});

describe('registerHealthSchedule', () => {
  it('registers one scheduler by a fixed id, once a day, so several workers still make one check', async () => {
    const upsertJobScheduler = vi.fn().mockResolvedValue(undefined);
    await registerHealthSchedule({ upsertJobScheduler });
    await registerHealthSchedule({ upsertJobScheduler });
    for (const call of upsertJobScheduler.mock.calls) {
      expect(call[0]).toBe('meta-health');
      expect(call[1]).toEqual({ every: 24 * 3600_000 });
      expect(call[2]).toMatchObject({ name: 'health' });
    }
    expect(upsertJobScheduler).toHaveBeenCalledTimes(2);
  });
});

describe('metaProcessors', () => {
  const withContext = vi.fn();
  const process = { db: { withContext } as never, log: vi.fn() };

  it('re-validates the job: a malformed one is rejected and nothing touches the database', async () => {
    const p = metaProcessors({ process });
    await expect(p.event(job({ tenantId: 'nope', eventId: ids.eventId }))).rejects.toThrow();
    await expect(p.event(job({}))).rejects.toThrow();
    expect(withContext).not.toHaveBeenCalled();
  });

  it('runs the event in the tenant named by the job', async () => {
    const calls: unknown[] = [];
    const db = {
      withContext: async (ctx: unknown) => {
        calls.push(ctx);
        return { status: 'already' };
      },
    };
    await metaProcessors({ process: { db: db as never, log: vi.fn() } }).event(job(ids));
    expect(calls).toEqual([{ tenantId: ids.tenantId }]);
  });

  it('the daily health job does nothing without a Meta app, and sweeps when there is one', async () => {
    await expect(metaProcessors({ process }).health()).resolves.toBeUndefined();
    const liveSocialConnections = vi.fn().mockResolvedValue([]);
    const health = {
      db: { liveSocialConnections },
      graph: {},
      vault: {},
      log: vi.fn(),
      now: () => new Date(),
    };
    await metaProcessors({ process, health: health as never }).health();
    expect(liveSocialConnections).toHaveBeenCalledWith(null, 200);
  });
});

describe('onEventJobFailed', () => {
  it('only marks the event failed after the last attempt, and logs no data', async () => {
    const updateMany = vi.fn().mockResolvedValue({ count: 1 });
    const db = {
      withContext: async (_c: unknown, fn: (tx: unknown) => unknown) =>
        fn({ socialEvent: { updateMany } }),
    };
    const log = vi.fn();
    await onEventJobFailed(
      db as never,
      log,
      job(ids, { attemptsMade: 2 }),
      new Error('boom with secret text'),
    );
    expect(updateMany).not.toHaveBeenCalled();
    expect(log.mock.calls[0]![0]).toMatchObject({ outcome: 'will_retry' });
    await onEventJobFailed(
      db as never,
      log,
      job(ids, { attemptsMade: 5 }),
      new Error('boom with secret text'),
    );
    expect(updateMany).toHaveBeenCalledTimes(1);
    expect(updateMany.mock.calls[0]![0]).toMatchObject({
      where: { id: ids.eventId, tenantId: ids.tenantId, status: 'received' },
      data: { status: 'failed', error: 'processing_failed' },
    });
    expect(JSON.stringify(log.mock.calls)).not.toContain('secret text');
  });
});
