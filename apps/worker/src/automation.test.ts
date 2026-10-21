import { describe, expect, it, vi } from 'vitest';
import { automationProcessors, logFailedJob, registerTick, type JobLike } from './automation.js';

const job = (over: Partial<JobLike> = {}): JobLike => ({
  id: 'j1',
  data: {},
  attemptsStarted: 1,
  opts: { attempts: 5 },
  ...over,
});

const wiring = () => {
  const db = {
    enabledAutomationRules: vi.fn().mockResolvedValue([]),
    stalePendingDeliveries: vi.fn().mockResolvedValue([]),
    withContext: vi.fn(),
    removePushToken: vi.fn(),
  };
  const queues = { evaluate: { add: vi.fn() }, deliver: { add: vi.fn() } };
  const log = vi.fn();
  const now = () => new Date('2026-10-25T14:30:00Z');
  return {
    db,
    queues,
    log,
    w: {
      evaluate: { db, queues, now, log, providers: { sms: false, whatsapp: false } },
      deliver: { db, providers: { push: {}, email: null, sms: null, whatsapp: null }, now, log },
      tick: { db, queues, now, log },
    } as never,
  };
};

describe('registerTick', () => {
  it('registers one scheduler by a fixed id, every minute, so several workers still make one tick', async () => {
    const upsertJobScheduler = vi.fn().mockResolvedValue(undefined);
    await registerTick({ upsertJobScheduler });
    await registerTick({ upsertJobScheduler }); // a second worker starting
    expect(upsertJobScheduler).toHaveBeenCalledTimes(2);
    for (const call of upsertJobScheduler.mock.calls) {
      expect(call[0]).toBe('automation-tick');
      expect(call[1]).toEqual({ every: 60_000 });
      expect(call[2]).toMatchObject({ name: 'tick' });
    }
  });
});

describe('automationProcessors', () => {
  it('the tick looks for due rules and stale deliveries', async () => {
    const { w, db } = wiring();
    await automationProcessors(w).tick();
    expect(db.enabledAutomationRules).toHaveBeenCalledWith(null, 500);
    expect(db.stalePendingDeliveries).toHaveBeenCalled();
  });

  it('re-validates job data coming out of Redis: a malformed job is rejected, not trusted', async () => {
    const { w } = wiring();
    const p = automationProcessors(w);
    await expect(p.evaluate(job({ data: { type: 'scan', tenantId: 'nope' } }))).rejects.toThrow();
    await expect(p.evaluate(job({ data: { type: 'something-else' } }))).rejects.toThrow();
    await expect(p.deliver(job({ data: { tenantId: 'x', deliveryId: 'y' } }))).rejects.toThrow();
  });

  it('a new-order job for a business with no enabled rule does nothing', async () => {
    const { w, db } = wiring();
    db.withContext.mockResolvedValue(null);
    await automationProcessors(w).evaluate(
      job({
        data: {
          type: 'neworder',
          tenantId: '00000000-0000-4000-8000-000000000001',
          orderId: '00000000-0000-4000-8000-000000000002',
        },
      }),
    );
    expect(db.withContext).toHaveBeenCalledTimes(1);
  });

  it('receipts jobs go to the receipts handler, not the delivery claim', async () => {
    const { w, db } = wiring();
    await automationProcessors(w).deliver(
      job({ name: 'receipts', data: { tickets: [{ id: 't1', token: 'ExponentPushToken[abc]' }] } }),
    );
    expect(db.withContext).not.toHaveBeenCalled();
  });
});

describe('logFailedJob', () => {
  it('says whether the job will be retried, and never logs the job data or the error message', () => {
    const log = vi.fn();
    logFailedJob(
      log,
      'automation',
      job({ attemptsStarted: 2, data: { secret: 'x' } }),
      new Error('secret detail'),
    );
    logFailedJob(log, 'automation', job({ attemptsStarted: 5 }), new Error('boom'));
    expect(log.mock.calls[0]![0]).toMatchObject({
      outcome: 'will_retry',
      attempt: 2,
      queue: 'automation',
    });
    expect(log.mock.calls[1]![0]).toMatchObject({ outcome: 'exhausted' });
    expect(JSON.stringify(log.mock.calls)).not.toContain('secret');
  });
});
