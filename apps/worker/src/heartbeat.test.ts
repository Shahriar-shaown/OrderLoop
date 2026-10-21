import { describe, expect, it, vi } from 'vitest';
import { HEARTBEAT_KEY, HEARTBEAT_TTL_SECONDS, startHeartbeat } from './heartbeat.js';

describe('startHeartbeat', () => {
  it('writes the time under worker:heartbeat straight away and on every tick, with an expiry', async () => {
    const set = vi.fn().mockResolvedValue('OK');
    let tick: () => void = () => undefined;
    const stop = vi.fn();
    const now = vi
      .fn()
      .mockReturnValueOnce(new Date('2026-10-30T10:00:00Z'))
      .mockReturnValue(new Date('2026-10-30T10:00:30Z'));
    const hb = startHeartbeat({
      redis: { set },
      now,
      log: vi.fn(),
      schedule: (fn) => {
        tick = fn;
        return { stop };
      },
    });
    await Promise.resolve();
    expect(set).toHaveBeenCalledWith(
      HEARTBEAT_KEY,
      '2026-10-30T10:00:00.000Z',
      'EX',
      HEARTBEAT_TTL_SECONDS,
    );
    tick();
    await Promise.resolve();
    expect(set).toHaveBeenCalledTimes(2);
    expect(set).toHaveBeenLastCalledWith(HEARTBEAT_KEY, '2026-10-30T10:00:30.000Z', 'EX', 90);
    hb.stop();
    expect(stop).toHaveBeenCalled();
    expect(HEARTBEAT_KEY).toBe('worker:heartbeat');
  });

  it('logs a failed write and keeps going', async () => {
    const set = vi.fn().mockRejectedValueOnce(new Error('redis down')).mockResolvedValue('OK');
    const log = vi.fn();
    const hb = startHeartbeat({ redis: { set }, log, schedule: () => ({ stop: () => undefined }) });
    await hb.beat();
    expect(log).toHaveBeenCalledWith(expect.stringContaining('redis down'));
    await hb.beat();
    expect(set).toHaveBeenCalledTimes(3);
  });
});
