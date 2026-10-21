import { describe, expect, it, vi } from 'vitest';
import { runAutomationTick, slotFor } from './tick.js';

const rule = (over: object = {}) => ({
  id: '0197b0a0-0000-7000-8000-000000000001',
  tenantId: '0197b0a0-0000-7000-8000-0000000000aa',
  kind: 'LOW_STOCK' as const,
  config: {},
  timezone: 'Asia/Dhaka',
  ...over,
});

const deps = (rules: ReturnType<typeof rule>[], at: string) => {
  const jobs = new Map<string, { data: Record<string, unknown> }>();
  // a queue that behaves like BullMQ: a second add with the same job id is ignored
  const add = vi.fn(async (_name: string, data: object, opts?: { jobId?: string }) => {
    if (opts?.jobId && jobs.has(opts.jobId)) return;
    jobs.set(opts?.jobId ?? `${jobs.size}`, { data: data as Record<string, unknown> });
  });
  return {
    jobs,
    deps: {
      db: {
        enabledAutomationRules: vi.fn(async (after: string | null) => (after ? [] : rules)),
        stalePendingDeliveries: vi.fn(async () => []),
      },
      queues: { evaluate: { add }, deliver: { add: vi.fn() } },
      now: () => new Date(at),
      log: vi.fn(),
    } as never,
  };
};

describe('slotFor', () => {
  it('scan kinds use the five-minute bucket; reports use the local-date slot or nothing', () => {
    const now = new Date('2026-03-29T14:03:20Z');
    expect(slotFor('LOW_STOCK', {}, 'Asia/Dhaka', now)?.slotKey).toBe('scan:20260329T1400Z');
    expect(slotFor('DAILY_REPORT', { localTime: '20:00' }, 'Asia/Dhaka', now)?.slotKey).toBe(
      'daily:2026-03-29',
    );
    expect(slotFor('DAILY_REPORT', { localTime: '21:00' }, 'Asia/Dhaka', now)).toBeNull();
    expect(
      slotFor('WEEKLY_REPORT', { localTime: '09:00', weekday: 1 }, 'Asia/Dhaka', now),
    ).toBeNull(); // a Sunday
    expect(slotFor('DAILY_REPORT', { localTime: 'bad' }, 'Asia/Dhaka', now)).toBeNull();
    expect(slotFor('DAILY_REPORT', { localTime: '20:00' }, 'Not/AZone', now)).toBeNull();
  });
});

describe('runAutomationTick', () => {
  it('queues one evaluation per due rule under a deterministic id, and a repeat tick in the same slot adds nothing', async () => {
    const r1 = rule();
    const r2 = rule({
      id: '0197b0a0-0000-7000-8000-000000000002',
      kind: 'DAILY_REPORT',
      config: { localTime: '20:00' },
    });
    const { deps: d, jobs } = deps([r1, r2], '2026-03-29T14:00:30Z');
    expect(await runAutomationTick(d)).toMatchObject({ rules: 2, queued: 2 });
    expect([...jobs.keys()].sort()).toEqual([
      `${r1.id}__scan_20260329T1400Z`,
      `${r2.id}__daily_2026-03-29`,
    ]);
    // a minute later (same bucket) and a second worker doing the same: still two jobs
    await runAutomationTick(d);
    await runAutomationTick(d);
    expect(jobs.size).toBe(2);
    // data is ids and slot names only
    for (const j of jobs.values())
      expect(Object.keys(j.data).sort()).toEqual([
        'kind',
        'ruleId',
        'scheduledFor',
        'slotKey',
        'tenantId',
        'type',
      ]);
  });

  it('a rule whose queueing fails does not stop the others', async () => {
    const bad = rule({ id: '0197b0a0-0000-7000-8000-000000000003' });
    const good = rule({ id: '0197b0a0-0000-7000-8000-000000000004' });
    const { deps: d, jobs } = deps([bad, good], '2026-03-29T14:00:30Z');
    const add = (d as unknown as { queues: { evaluate: { add: ReturnType<typeof vi.fn> } } }).queues
      .evaluate.add;
    const original = add.getMockImplementation()!;
    add.mockImplementation(async (name: string, data: { ruleId: string }, opts: object) => {
      if (data.ruleId === bad.id) throw new Error('redis down');
      return original(name, data, opts);
    });
    expect(await runAutomationTick(d)).toMatchObject({ rules: 2, queued: 1 });
    expect(jobs.size).toBe(1);
  });

  it('re-queues deliveries that were committed but never queued, under their own deterministic id', async () => {
    const { deps: d } = deps([], '2026-03-29T14:00:30Z');
    const deliverAdd = vi.fn();
    (d as never as { queues: { deliver: { add: unknown } } }).queues.deliver.add = deliverAdd;
    (d as never as { db: { stalePendingDeliveries: unknown } }).db.stalePendingDeliveries = vi.fn(
      async () => [
        {
          id: '0197b0a0-0000-7000-8000-0000000000d1',
          tenantId: '0197b0a0-0000-7000-8000-0000000000aa',
        },
      ],
    );
    expect((await runAutomationTick(d)).requeuedDeliveries).toBe(1);
    expect(deliverAdd).toHaveBeenCalledWith(
      'deliver',
      {
        tenantId: '0197b0a0-0000-7000-8000-0000000000aa',
        deliveryId: '0197b0a0-0000-7000-8000-0000000000d1',
      },
      expect.objectContaining({
        jobId: 'delivery__0197b0a0-0000-7000-8000-0000000000d1',
        attempts: 5,
      }),
    );
  });
});
