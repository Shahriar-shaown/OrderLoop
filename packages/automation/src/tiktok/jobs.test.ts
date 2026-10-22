import { describe, expect, it, vi } from 'vitest';
import {
  TIKTOK_JOB_OPTIONS,
  TIKTOK_QUEUES,
  TIKTOK_SCHEDULES,
  TikTokEventJob,
  enqueueTikTokEvent,
  tiktokEventJobId,
} from './jobs.js';

const ids = {
  tenantId: '11111111-1111-4111-8111-111111111111',
  eventId: '22222222-2222-4222-8222-222222222222',
};

describe('TikTok jobs', () => {
  it('carry ids only, and are re-validated', () => {
    expect(TikTokEventJob.parse(ids)).toEqual(ids);
    expect(() => TikTokEventJob.parse({ tenantId: 'x', eventId: ids.eventId })).toThrow();
    expect(Object.keys(TikTokEventJob.parse({ ...ids, extra: 'no' }))).toEqual([
      'tenantId',
      'eventId',
    ]);
  });

  it('get a deterministic id with no colon (BullMQ refuses one), so queueing twice is a no-op', () => {
    expect(tiktokEventJobId(ids.eventId)).toBe(`tiktok-event__${ids.eventId}`);
    expect(tiktokEventJobId('a:b')).not.toContain(':');
  });

  it('the schedulers have fixed ids and the intervals of the design: sync 10 min, refresh 15 min, health daily', () => {
    expect(TIKTOK_SCHEDULES.sync).toEqual({ id: 'tiktok-sync', every: 600_000 });
    expect(TIKTOK_SCHEDULES.refresh).toEqual({ id: 'tiktok-refresh', every: 900_000 });
    expect(TIKTOK_SCHEDULES.health).toEqual({ id: 'tiktok-health', every: 86_400_000 });
    expect(TIKTOK_QUEUES).toEqual({ events: 'tiktok-events', maintenance: 'tiktok-maintenance' });
  });

  it('queueing passes the id and the retry options; a slow or dead Redis resolves false instead of waiting', async () => {
    const add = vi.fn().mockResolvedValue(undefined);
    expect(await enqueueTikTokEvent({ add }, ids)).toBe(true);
    expect(add).toHaveBeenCalledWith('event', ids, {
      jobId: tiktokEventJobId(ids.eventId),
      ...TIKTOK_JOB_OPTIONS,
    });
    expect(TIKTOK_JOB_OPTIONS.attempts).toBe(5);
    expect(await enqueueTikTokEvent({ add: () => Promise.reject(new Error('down')) }, ids)).toBe(
      false,
    );
    const started = Date.now();
    expect(await enqueueTikTokEvent({ add: () => new Promise(() => undefined) }, ids, 50)).toBe(
      false,
    );
    expect(Date.now() - started).toBeLessThan(1000);
  });
});
