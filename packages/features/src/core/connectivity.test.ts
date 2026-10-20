import { ApiError } from '@orderloop/api-client';
import { describe, expect, it, vi } from 'vitest';
import { createConnectivityStore, OFFLINE_MESSAGE, withOfflineGuard } from './connectivity';
import { createRuntime } from './runtime';

const ok = () => vi.fn(async () => new Response('{}', { status: 200 }));

describe('withOfflineGuard', () => {
  it('lets every read through while offline (they just fail, or wait, and cached data stays)', async () => {
    const base = ok();
    const guarded = withOfflineGuard(
      base as unknown as typeof fetch,
      createConnectivityStore(false),
    );
    for (const method of ['GET', 'HEAD', 'OPTIONS'])
      await guarded('http://x/v1/orders', { method });
    expect(base).toHaveBeenCalledTimes(3);
  });

  it('refuses every write while offline, before anything is sent, with a message that says nothing went out', async () => {
    const base = ok();
    const guarded = withOfflineGuard(
      base as unknown as typeof fetch,
      createConnectivityStore(false),
    );
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
      const error = await guarded('http://x/v1/orders', { method }).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(ApiError);
      expect(error).toMatchObject({ code: 'offline', message: OFFLINE_MESSAGE });
    }
    expect(base).not.toHaveBeenCalled();
  });

  it('sends writes normally when online, and again once the connection is back', async () => {
    const base = ok();
    const store = createConnectivityStore(false);
    const guarded = withOfflineGuard(base as unknown as typeof fetch, store);
    store.set(true);
    await guarded('http://x/v1/orders', { method: 'POST' });
    expect(base).toHaveBeenCalledTimes(1);
  });

  it('asks the platform to check the connection when a request got no answer at all', async () => {
    const reportFailure = vi.fn();
    const store = { ...createConnectivityStore(true), reportFailure };
    const guarded = withOfflineGuard(
      (async () => {
        throw new TypeError('Network request failed');
      }) as unknown as typeof fetch,
      store,
    );
    await expect(guarded('http://x/v1/orders')).rejects.toThrow('Network request failed');
    expect(reportFailure).toHaveBeenCalledTimes(1);
  });
});

describe('the app runtime while offline', () => {
  it('never sends an order, a payment or a courier booking: the API client fails them at once', async () => {
    const real = vi.fn(async () => new Response('{}', { status: 200 }));
    vi.stubGlobal('fetch', real);
    const connectivity = createConnectivityStore(false);
    const { api } = createRuntime({ baseUrl: 'http://api.test', connectivity });
    const id = '0197b0a0-0000-7000-8000-000000000001';
    const attempts = [
      api.orders.changeStatus(id, { status: 'confirmed' }),
      api.orders.bulkChangeStatus({ orderIds: [id], status: 'confirmed' }),
      api.shipments.book(id, { provider: 'mock', idempotencyKey: 'booking-key-0001' }),
    ];

    for (const attempt of attempts)
      await expect(attempt).rejects.toMatchObject({ code: 'offline' });
    expect(real).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });
});
