import 'reflect-metadata';
import { describe, expect, it } from 'vitest';
import { ACCOUNT_MAX, LoginThrottleService, PER_IP_MAX } from './login-throttle.service.js';

function fakeRedis() {
  const store = new Map<string, number>();
  return {
    get: async (k: string) => (store.has(k) ? String(store.get(k)) : null),
    incr: async (k: string) => store.set(k, (store.get(k) ?? 0) + 1).get(k)!,
    expire: async () => 1,
    ttl: async () => 600,
    del: async (...keys: string[]) => keys.filter((k) => store.delete(k)).length,
  };
}

describe('LoginThrottleService', () => {
  it('locks only the (account, IP) pair that failed, not other IPs', async () => {
    const svc = new LoginThrottleService(fakeRedis());
    for (let i = 0; i < PER_IP_MAX; i++) await svc.recordFailure('victim@example.test', '1.1.1.1');
    await expect(svc.assertNotLocked('victim@example.test', '1.1.1.1')).rejects.toMatchObject({
      status: 429,
    });
    // The real owner, from another IP, is not locked out by someone else's guesses.
    await expect(svc.assertNotLocked('victim@example.test', '2.2.2.2')).resolves.toBeUndefined();
  });

  it('locks the account for everyone once guessing is spread over many IPs', async () => {
    const svc = new LoginThrottleService(fakeRedis());
    for (let i = 0; i < ACCOUNT_MAX; i++)
      await svc.recordFailure('victim@example.test', `10.0.0.${i}`);
    await expect(svc.assertNotLocked('victim@example.test', '9.9.9.9')).rejects.toMatchObject({
      status: 429,
    });
  });

  it('does not mix up different accounts', async () => {
    const svc = new LoginThrottleService(fakeRedis());
    for (let i = 0; i < PER_IP_MAX; i++) await svc.recordFailure('a@example.test', '1.1.1.1');
    await expect(svc.assertNotLocked('b@example.test', '1.1.1.1')).resolves.toBeUndefined();
  });

  it('clearing after a successful login resets both counters', async () => {
    const svc = new LoginThrottleService(fakeRedis());
    for (let i = 0; i < PER_IP_MAX - 1; i++) await svc.recordFailure('a@example.test', '1.1.1.1');
    await svc.clear('a@example.test', '1.1.1.1');
    for (let i = 0; i < PER_IP_MAX - 1; i++) await svc.recordFailure('a@example.test', '1.1.1.1');
    await expect(svc.assertNotLocked('a@example.test', '1.1.1.1')).resolves.toBeUndefined();
  });

  it('fails open when redis is unavailable', async () => {
    const broken = new Proxy(
      {},
      {
        get: () => async () => {
          throw new Error('down');
        },
      },
    ) as never;
    const svc = new LoginThrottleService(broken);
    await expect(svc.assertNotLocked('a@example.test', '1.1.1.1')).resolves.toBeUndefined();
    await expect(svc.recordFailure('a@example.test', '1.1.1.1')).resolves.toBeUndefined();
  });
});
