import { describe, expect, it, vi } from 'vitest';
import { KEY_TTL_SECONDS, purgeIdempotencyKeys } from './purge-idempotency.js';

describe('purgeIdempotencyKeys', () => {
  it('asks for keys older than a day and reports how many went', async () => {
    const purge = vi.fn().mockResolvedValue(3);
    const log = vi.fn();
    expect(await purgeIdempotencyKeys({ purge, log })).toBe(3);
    expect(purge).toHaveBeenCalledWith(KEY_TTL_SECONDS);
    expect(KEY_TTL_SECONDS).toBe(86_400);
    expect(log).toHaveBeenCalledOnce();
  });

  it('says nothing when there was nothing to remove', async () => {
    const log = vi.fn();
    expect(await purgeIdempotencyKeys({ purge: async () => 0, log })).toBe(0);
    expect(log).not.toHaveBeenCalled();
  });
});
