import 'reflect-metadata';
import { describe, expect, it, vi } from 'vitest';
import { HealthService, READY_CACHE_MS } from './health.service.js';

function service() {
  process.env['DATABASE_URL'] ??= 'postgresql://u:p@localhost:5433/db';
  process.env['REDIS_URL'] ??= 'redis://localhost:6379';
  process.env['NODE_ENV'] ??= 'test';
  const s = new HealthService();
  const pg = vi.fn().mockResolvedValue('up');
  const redis = vi.fn().mockResolvedValue('up');
  (s as unknown as { pingPostgres: unknown }).pingPostgres = pg;
  (s as unknown as { pingRedis: unknown }).pingRedis = redis;
  return { s, pg, redis };
}

describe('HealthService readiness cache', () => {
  it('probes once for concurrent callers and for calls within the cache window', async () => {
    const { s, pg, redis } = service();
    const results = await Promise.all(Array.from({ length: 50 }, () => s.check(1000)));
    expect(results.every((r) => r.status === 'ok')).toBe(true);
    await s.check(1000 + READY_CACHE_MS - 1);
    expect(pg).toHaveBeenCalledTimes(1);
    expect(redis).toHaveBeenCalledTimes(1);
  });
  it('probes again once the window has passed', async () => {
    const { s, pg } = service();
    await s.check(1000);
    await s.check(1000 + READY_CACHE_MS);
    expect(pg).toHaveBeenCalledTimes(2);
  });
});
