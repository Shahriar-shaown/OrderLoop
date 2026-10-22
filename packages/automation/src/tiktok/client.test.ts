import { describe, expect, it } from 'vitest';
import { TikTokApiError, TikTokShopClient, classifyTikTokError } from './client.js';
import { tiktokRequestSignature } from './signature.js';

const APP_KEY = '6abc12';
const APP_SECRET = 'sekret0123456789ab';
const NOW = new Date('2026-10-22T00:00:00Z');

interface Req {
  url: URL;
  init: RequestInit;
}
const reply = (status: number, body: unknown) =>
  ({ ok: status < 400, status, json: async () => body }) as Response;

function client(
  handler: (req: Req) => Response | Promise<Response>,
  over: { timeoutMs?: number } = {},
) {
  const calls: Req[] = [];
  const c = new TikTokShopClient({
    fetch: (async (url: string, init: RequestInit) => {
      const req = { url: new URL(url), init };
      calls.push(req);
      return handler(req);
    }) as unknown as typeof fetch,
    appKey: APP_KEY,
    appSecret: APP_SECRET,
    authHost: 'https://auth.example.test',
    apiHost: 'https://api.example.test/',
    version: '202309',
    now: () => NOW,
    ...over,
  });
  return { c, calls };
}
const ok = (data: unknown) => reply(200, { code: 0, message: 'Success', request_id: 'r', data });

describe('classifyTikTokError', () => {
  it('lets the HTTP status decide first', () => {
    expect(classifyTikTokError(429, 0, 'x')).toBe('rate_limited');
    expect(classifyTikTokError(500, 0, 'x')).toBe('unavailable');
    expect(classifyTikTokError(503, null, 'x')).toBe('unavailable');
    expect(classifyTikTokError(401, 1, 'whatever')).toBe('token_invalid');
    expect(classifyTikTokError(403, 1, 'whatever')).toBe('permission');
  });
  it('reads the message when the status says nothing, and the two token codes every SDK lists', () => {
    expect(classifyTikTokError(200, 105001, 'x')).toBe('token_invalid');
    expect(classifyTikTokError(200, 36004004, 'refresh token expired')).toBe('token_invalid');
    expect(classifyTikTokError(200, 1, 'Invalid access_token')).toBe('token_invalid');
    expect(classifyTikTokError(200, 1, 'auth_code is wrong')).toBe('token_invalid');
    expect(classifyTikTokError(200, 1, 'Too many requests, slow down')).toBe('rate_limited');
    expect(classifyTikTokError(200, 1, 'rate limit reached')).toBe('rate_limited');
    expect(classifyTikTokError(200, 1, 'no permission for this scope')).toBe('permission');
    expect(classifyTikTokError(200, 1, 'app not authorized for shop')).toBe('permission');
  });
  it('treats anything else as a bad request (never a retry loop), and does not mistake words that merely contain "rate"', () => {
    expect(classifyTikTokError(400, 12052, 'page_size must be at most 50')).toBe('bad_request');
    expect(classifyTikTokError(200, 1, 'could not generate the label')).toBe('bad_request');
    expect(classifyTikTokError(200, 1, 'operate')).toBe('bad_request');
  });
  it('marks only rate limits and outages as worth retrying', () => {
    const e = (kind: ConstructorParameters<typeof TikTokApiError>[0]) =>
      new TikTokApiError(kind, 'm', null, null).retryable;
    expect([
      e('rate_limited'),
      e('unavailable'),
      e('token_invalid'),
      e('permission'),
      e('bad_request'),
    ]).toEqual([true, true, false, false, false]);
  });
});

describe('the sign-in and token calls', () => {
  it('builds the authorize URL from the auth host, the app key and the state', () => {
    const { c } = client(() => ok({}));
    const u = new URL(c.authorizeUrl('st ate'));
    expect(`${u.origin}${u.pathname}`).toBe('https://auth.example.test/oauth/authorize');
    expect(u.searchParams.get('app_key')).toBe(APP_KEY);
    expect(u.searchParams.get('state')).toBe('st ate');
    expect([...u.searchParams.keys()].sort()).toEqual(['app_key', 'state']);
  });

  it('exchanges the code with GET /api/v2/token/get and reads both expiries (a timestamp or seconds)', async () => {
    const { c, calls } = client(() =>
      ok({
        access_token: 'ROW_a',
        refresh_token: 'ROW_r',
        access_token_expire_in: 1_792_000_000,
        refresh_token_expire_in: 864_000,
        granted_scopes: ['seller.order.info', 7],
      }),
    );
    const g = await c.exchangeCode('CODE1');
    expect(calls[0]!.init.method).toBe('GET');
    expect(calls[0]!.url.pathname).toBe('/api/v2/token/get');
    expect(Object.fromEntries(calls[0]!.url.searchParams)).toEqual({
      app_key: APP_KEY,
      app_secret: APP_SECRET,
      auth_code: 'CODE1',
      grant_type: 'authorized_code',
    });
    expect(g).toEqual({
      accessToken: 'ROW_a',
      refreshToken: 'ROW_r',
      accessExpiresAt: new Date(1_792_000_000_000),
      refreshExpiresAt: new Date(NOW.getTime() + 864_000_000),
      scopes: ['seller.order.info'],
    });
  });

  it('refreshes with GET /api/v2/token/refresh; an answer with no new refresh token and no expiry is read as such', async () => {
    const { c, calls } = client(() => ok({ access_token: 'ROW_a2' }));
    const g = await c.refresh('ROW_old');
    expect(calls[0]!.url.pathname).toBe('/api/v2/token/refresh');
    expect(Object.fromEntries(calls[0]!.url.searchParams)).toMatchObject({
      grant_type: 'refresh_token',
      refresh_token: 'ROW_old',
    });
    expect(g).toMatchObject({
      accessToken: 'ROW_a2',
      refreshToken: '',
      accessExpiresAt: null,
      refreshExpiresAt: null,
    });
  });

  it('an answer with no access token is not a success', async () => {
    const { c } = client(() => ok({}));
    await expect(c.exchangeCode('c')).rejects.toMatchObject({ kind: 'unavailable' });
  });

  it('reads the envelope: HTTP 200 with a non-zero code is a failure, and the text never carries a secret', async () => {
    const { c } = client(() =>
      reply(200, {
        code: 36004004,
        message: 'bad request: auth_code=SECRETCODE app_secret=sekret0123456789ab and ROW_leak',
      }),
    );
    const err = await c.exchangeCode('SECRETCODE').catch((e) => e as TikTokApiError);
    expect(err).toBeInstanceOf(TikTokApiError);
    expect(err.kind).toBe('token_invalid');
    expect(err.code).toBe(36004004);
    expect(err.httpStatus).toBe(200);
    expect(err.message).not.toContain('SECRETCODE');
    expect(err.message).not.toContain(APP_SECRET);
    expect(err.message).toContain('[token]');
  });
});

describe('shop calls', () => {
  it('sign every request as the SDK does: path, sorted query, body, secret on both sides; token in the header only', async () => {
    const { c, calls } = client(() => ok({ orders: [], next_page_token: '', total_count: 0 }));
    await c.searchOrders(
      { accessToken: 'ROW_tok', shopCipher: 'ROW_cipher' },
      { updateTimeGe: 100, updateTimeLt: 200, pageToken: 'p2', pageSize: 20 },
    );
    const { url, init } = calls[0]!;
    expect(init.method).toBe('POST');
    expect(url.origin).toBe('https://api.example.test');
    expect(url.pathname).toBe('/order/202309/orders/search');
    const q = Object.fromEntries(url.searchParams);
    expect(q).toMatchObject({
      app_key: APP_KEY,
      shop_cipher: 'ROW_cipher',
      page_size: '20',
      page_token: 'p2',
      sort_field: 'update_time',
      sort_order: 'ASC',
      timestamp: String(Math.floor(NOW.getTime() / 1000)),
    });
    expect(init.body).toBe('{"update_time_ge":100,"update_time_lt":200}');
    const { sign, ...unsigned } = q;
    expect(sign).toBe(
      tiktokRequestSignature({
        path: url.pathname,
        query: unsigned,
        body: init.body as string,
        appSecret: APP_SECRET,
      }),
    );
    expect((init.headers as Record<string, string>)['x-tts-access-token']).toBe('ROW_tok');
    expect(url.toString()).not.toContain('ROW_tok');
    expect(url.searchParams.has('access_token')).toBe(false);
  });

  it('reads order details with GET (ids joined, at most 50), and answers nothing for no ids', async () => {
    const { c, calls } = client(() => ok({ orders: [{ id: 'a' }] }));
    expect(await c.getOrders({ accessToken: 't', shopCipher: 'c' }, [])).toEqual([]);
    expect(calls).toHaveLength(0);
    const ids = Array.from({ length: 60 }, (_, i) => `o${i}`);
    expect(await c.getOrders({ accessToken: 't', shopCipher: 'c' }, ids)).toEqual([{ id: 'a' }]);
    expect(calls[0]!.init.method).toBe('GET');
    expect(calls[0]!.url.pathname).toBe('/order/202309/orders');
    expect(calls[0]!.url.searchParams.get('ids')!.split(',')).toHaveLength(50);
    expect(calls[0]!.init.body).toBeUndefined();
  });

  it('lists the authorised shops without sending a shop cipher, and skips entries without an id or cipher', async () => {
    const { c, calls } = client(() =>
      ok({
        shops: [
          { id: '1', cipher: 'ROW_c1', name: 'One', region: 'MY', seller_type: 'LOCAL' },
          { id: '2' },
          { cipher: 'x' },
          { id: '3', cipher: 'ROW_c3' },
        ],
      }),
    );
    const shops = await c.getAuthorizedShops('ROW_tok');
    expect(calls[0]!.url.pathname).toBe('/authorization/202309/shops');
    expect(calls[0]!.url.searchParams.has('shop_cipher')).toBe(false);
    expect(shops).toEqual([
      { id: '1', cipher: 'ROW_c1', name: 'One', region: 'MY', sellerType: 'LOCAL' },
      { id: '3', cipher: 'ROW_c3', name: '3', region: null, sellerType: null },
    ]);
  });

  it('subscribes a webhook with the Events API (PUT, signed body)', async () => {
    const { c, calls } = client(() => ok({}));
    await c.updateWebhook(
      { accessToken: 't', shopCipher: 'c' },
      'ORDER_STATUS_CHANGE',
      'https://x.test/hook',
    );
    expect(calls[0]!.init.method).toBe('PUT');
    expect(calls[0]!.url.pathname).toBe('/event/202309/webhooks');
    expect(JSON.parse(calls[0]!.init.body as string)).toEqual({
      address: 'https://x.test/hook',
      event_type: 'ORDER_STATUS_CHANGE',
    });
  });

  it('maps failures to kinds, never echoing the access token', async () => {
    const run = async (status: number, body: unknown) => {
      const { c } = client(() => reply(status, body));
      return c
        .getOrders({ accessToken: 'ROW_secret_token', shopCipher: 'c' }, ['1'])
        .catch((e) => e as TikTokApiError);
    };
    expect(
      await run(401, { code: 105002, message: 'token ROW_secret_token expired' }),
    ).toMatchObject({ kind: 'token_invalid', httpStatus: 401 });
    expect(await run(429, { code: 1, message: 'slow' })).toMatchObject({ kind: 'rate_limited' });
    expect(await run(503, { code: 1, message: 'down' })).toMatchObject({ kind: 'unavailable' });
    expect(await run(403, { code: 1, message: 'no permission' })).toMatchObject({
      kind: 'permission',
    });
    expect(await run(200, { code: 12052, message: 'bad parameter' })).toMatchObject({
      kind: 'bad_request',
      code: 12052,
    });
    const leak = await run(401, {
      code: 105002,
      message: 'access_token=ROW_secret_token is bad, ROW_secret_token',
    });
    expect(leak.message).not.toContain('ROW_secret_token');
  });

  it('a network error, a timeout, a non-JSON answer and a wrong shape are all "unavailable" (a 429 body that is not JSON is a rate limit)', async () => {
    const kinds = async (fn: () => Promise<Response>) => {
      const { c } = client(fn);
      return c
        .getOrders({ accessToken: 't', shopCipher: 'c' }, ['1'])
        .catch((e) => (e as TikTokApiError).kind);
    };
    expect(await kinds(() => Promise.reject(new TypeError('fetch failed')))).toBe('unavailable');
    expect(
      await kinds(() => Promise.reject(Object.assign(new Error('t'), { name: 'TimeoutError' }))),
    ).toBe('unavailable');
    expect(
      await kinds(
        async () =>
          ({
            ok: true,
            status: 200,
            json: async () => Promise.reject(new SyntaxError('x')),
          }) as Response,
      ),
    ).toBe('unavailable');
    expect(
      await kinds(
        async () =>
          ({
            ok: false,
            status: 429,
            json: async () => Promise.reject(new SyntaxError('x')),
          }) as Response,
      ),
    ).toBe('rate_limited');
    expect(await kinds(async () => reply(200, ['not an envelope']))).toBe('unavailable');
    expect(await kinds(async () => reply(200, { message: 'no code' }))).toBe('bad_request');
  });

  it('puts a timeout on every call', async () => {
    let signal: AbortSignal | undefined;
    const { c } = client(
      ({ init }) => {
        signal = init.signal as AbortSignal;
        return ok({ orders: [] });
      },
      { timeoutMs: 1234 },
    );
    await c.getOrders({ accessToken: 't', shopCipher: 'c' }, ['1']);
    expect(signal).toBeInstanceOf(AbortSignal);
  });
});
