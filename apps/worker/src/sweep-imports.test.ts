import { describe, expect, it, vi } from 'vitest';
import { STALE_PENDING_MS, sweepPendingImports, type ImportRef } from './sweep-imports.js';

const ref = (n: number): ImportRef => ({
  tenantId: `00000000-0000-4000-8000-00000000000${n}`,
  importId: `10000000-0000-4000-8000-00000000000${n}`,
});

describe('sweepPendingImports', () => {
  it('queues each stale PENDING import under its own id, so queueing it again is a no-op', async () => {
    const add = vi.fn().mockResolvedValue(undefined);
    const find = vi.fn().mockResolvedValue([ref(1), ref(2)]);
    const log = vi.fn();
    expect(await sweepPendingImports({ find, queue: { add }, log })).toBe(2);
    expect(find).toHaveBeenCalledWith(STALE_PENDING_MS);
    expect(add).toHaveBeenCalledTimes(2);
    expect(add).toHaveBeenCalledWith(
      'products',
      ref(1),
      expect.objectContaining({ jobId: ref(1).importId, attempts: 3 }),
    );
    expect(log).toHaveBeenCalledTimes(2);
  });

  it('does nothing when nothing is stuck, and can run again straight away', async () => {
    const add = vi.fn();
    const find = vi.fn().mockResolvedValue([]);
    const deps = { find, queue: { add }, log: vi.fn() };
    expect(await sweepPendingImports(deps)).toBe(0);
    expect(await sweepPendingImports(deps)).toBe(0);
    expect(add).not.toHaveBeenCalled();
  });

  it('a failure to queue one is reported, not swallowed, so the next sweep tries again', async () => {
    const add = vi.fn().mockRejectedValue(new Error('redis down'));
    await expect(
      sweepPendingImports({ find: async () => [ref(1)], queue: { add }, log: vi.fn() }),
    ).rejects.toThrow('redis down');
  });
});
