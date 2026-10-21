import { describe, expect, it, vi } from 'vitest';
import { STALE_RECEIVED_SECONDS, sweepReceivedSocialEvents } from '@orderloop/automation';

const stale = (n: number) => ({
  id: `2222222${n}-2222-4222-8222-222222222222`,
  tenantId: '11111111-1111-4111-8111-111111111111',
});

describe('sweepReceivedSocialEvents', () => {
  it('queues each stored-but-unprocessed event under an id derived from the event, so again is a no-op', async () => {
    const staleReceivedSocialEvents = vi.fn().mockResolvedValue([stale(1), stale(2)]);
    const add = vi.fn().mockResolvedValue(undefined);
    const log = vi.fn();
    const n = await sweepReceivedSocialEvents({
      db: { staleReceivedSocialEvents } as never,
      queue: { add },
      log,
    });
    expect(n).toBe(2);
    expect(staleReceivedSocialEvents).toHaveBeenCalledWith(STALE_RECEIVED_SECONDS);
    expect(add).toHaveBeenCalledWith(
      'event',
      { tenantId: stale(1).tenantId, eventId: stale(1).id },
      expect.objectContaining({ jobId: `social-event__${stale(1).id}`, attempts: 5 }),
    );
  });
  it('does nothing when nothing is stuck', async () => {
    const add = vi.fn();
    expect(
      await sweepReceivedSocialEvents({
        db: { staleReceivedSocialEvents: async () => [] } as never,
        queue: { add },
        log: vi.fn(),
      }),
    ).toBe(0);
    expect(add).not.toHaveBeenCalled();
  });
  it('counts only what was really queued (Redis down: they stay for the next sweep)', async () => {
    const add = vi.fn().mockRejectedValue(new Error('redis down'));
    expect(
      await sweepReceivedSocialEvents({
        db: { staleReceivedSocialEvents: async () => [stale(1)] } as never,
        queue: { add },
        log: vi.fn(),
      }),
    ).toBe(0);
  });
});
