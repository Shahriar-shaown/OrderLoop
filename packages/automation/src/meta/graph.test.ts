import { describe, expect, it } from 'vitest';
import { MetaGraphClient, MetaGraphError, kindOfGraphError } from './graph.js';

const TOKEN = 'EAAGm0PX4ZCpsBAKtestPageToken1234567890abcdef';
const SECRET = 'a-sixteen-char-app-secret';

interface Call {
  url: string;
  method: string;
  body: string | undefined;
}
function fakeFetch(answers: (call: Call) => { status?: number; body: unknown } | Error) {
  const calls: Call[] = [];
  const fn = (async (url: string, init: { method: string; body?: string }) => {
    const call = { url: String(url), method: init.method, body: init.body };
    calls.push(call);
    const a = answers(call);
    if (a instanceof Error) throw a;
    return {
      ok: (a.status ?? 200) < 400,
      status: a.status ?? 200,
      json: async () => a.body,
    } as Response;
  }) as unknown as typeof fetch;
  return { fn, calls };
}
const client = (f: typeof fetch, extra: object = {}) =>
  new MetaGraphClient({
    fetch: f,
    version: 'v23.0',
    appId: '1234567890',
    appSecret: SECRET,
    ...extra,
  });
const graphError = (code: number, message = 'nope', status = 400) => ({
  status,
  body: { error: { message, type: 'OAuthException', code, fbtrace_id: 'x' } },
});

describe('error mapping', () => {
  it.each([
    [190, 'token_invalid'],
    [10, 'permission'],
    [200, 'permission'],
    [299, 'permission'],
    [4, 'rate_limited'],
    [17, 'rate_limited'],
    [32, 'rate_limited'],
    [613, 'rate_limited'],
    [100, 'bad_request'],
  ])('code %i is %s', async (code, kind) => {
    const f = fakeFetch(() => graphError(code));
    const error = await client(f.fn)
      .me(TOKEN)
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(MetaGraphError);
    expect((error as MetaGraphError).kind).toBe(kind);
    expect((error as MetaGraphError).code).toBe(code);
    expect((error as MetaGraphError).retryable).toBe(kind === 'rate_limited');
  });
  it('treats 5xx, network failures and non-JSON answers as unavailable (retryable)', async () => {
    const down = await client(fakeFetch(() => ({ status: 503, body: {} })).fn)
      .me(TOKEN)
      .catch((e: unknown) => e);
    expect((down as MetaGraphError).kind).toBe('unavailable');
    const net = await client(fakeFetch(() => new Error('ECONNRESET')).fn)
      .me(TOKEN)
      .catch((e: unknown) => e);
    expect((net as MetaGraphError).kind).toBe('unavailable');
    expect((net as MetaGraphError).retryable).toBe(true);
    const html = (async () => ({
      ok: true,
      status: 200,
      json: async () => Promise.reject(new Error('x')),
    })) as unknown as typeof fetch;
    expect(
      (
        (await client(html)
          .me(TOKEN)
          .catch((e: unknown) => e)) as MetaGraphError
      ).kind,
    ).toBe('unavailable');
  });
  it('gives up after the timeout', async () => {
    const never = ((_u: string, init: { signal: AbortSignal }) =>
      new Promise((_r, reject) => {
        init.signal.addEventListener('abort', () =>
          reject(Object.assign(new Error('t'), { name: 'TimeoutError' })),
        );
      })) as unknown as typeof fetch;
    const error = await client(never, { timeoutMs: 20 })
      .me(TOKEN)
      .catch((e: unknown) => e);
    expect((error as MetaGraphError).kind).toBe('unavailable');
    expect((error as MetaGraphError).message).toMatch(/in time/);
  });
  it('maps by HTTP status when there is no code', () => {
    expect(kindOfGraphError(null, 429)).toBe('rate_limited');
    expect(kindOfGraphError(null, 401)).toBe('token_invalid');
    expect(kindOfGraphError(null, 403)).toBe('permission');
    expect(kindOfGraphError(null, 502)).toBe('unavailable');
    expect(kindOfGraphError(12345, 400)).toBe('bad_request');
  });
});

describe('secrets never leak', () => {
  it('redacts tokens and the app secret from error messages, including ones Meta echoes back', async () => {
    const f = fakeFetch(() =>
      graphError(
        190,
        `Invalid OAuth access token ${TOKEN} (access_token=${TOKEN}&client_secret=${SECRET})`,
      ),
    );
    const error = (await client(f.fn)
      .me(TOKEN)
      .catch((e: unknown) => e)) as MetaGraphError;
    expect(error.message).not.toContain(TOKEN);
    expect(error.message).not.toContain(SECRET);
    expect(error.message).toContain('[token]');
    expect(JSON.stringify(error)).not.toContain(TOKEN);
  });
  it('keeps the token out of the URL for POST and out of a thrown error for the one-time code', async () => {
    const f = fakeFetch(() => graphError(100, 'bad code 4/ABC-one-time-code'));
    const error = (await client(f.fn)
      .exchangeCode('4/ABC-one-time-code', 'https://x.test/cb')
      .catch((e: unknown) => e)) as MetaGraphError;
    expect(error.message).not.toContain('4/ABC-one-time-code');
    const g = fakeFetch(() => ({ body: { success: true } }));
    await client(g.fn).subscribePage('111', TOKEN, ['messages', 'messaging_postbacks']);
    expect(g.calls[0]!.method).toBe('POST');
    expect(g.calls[0]!.url).not.toContain(TOKEN);
    expect(g.calls[0]!.url).toBe('https://graph.facebook.com/v23.0/111/subscribed_apps');
    expect(g.calls[0]!.body).toContain('subscribed_fields=messages%2Cmessaging_postbacks');
  });
});

describe('calls', () => {
  it('pins the version in every URL', async () => {
    const f = fakeFetch(() => ({ body: { id: '1', name: 'Shop' } }));
    await client(f.fn).me(TOKEN);
    expect(f.calls[0]!.url).toMatch(/^https:\/\/graph\.facebook\.com\/v23\.0\/me\?/);
  });
  it('builds the dialog URL with exactly the scopes it is given', () => {
    const url = new URL(
      client(fakeFetch(() => ({ body: {} })).fn).authorizeUrl({
        redirectUri: 'https://api.test/cb',
        state: 'S',
        scopes: ['pages_show_list', 'pages_messaging'],
      }),
    );
    expect(url.origin + url.pathname).toBe('https://www.facebook.com/v23.0/dialog/oauth');
    expect(url.searchParams.get('scope')).toBe('pages_show_list,pages_messaging');
    expect(url.searchParams.get('state')).toBe('S');
    expect(url.searchParams.get('client_id')).toBe('1234567890');
    expect(url.searchParams.get('redirect_uri')).toBe('https://api.test/cb');
    expect(url.searchParams.has('client_secret')).toBe(false);
  });
  it('uses a Facebook Login for Business configuration when one is set', () => {
    const url = new URL(
      client(fakeFetch(() => ({ body: {} })).fn, { loginConfigId: '999' }).authorizeUrl({
        redirectUri: 'https://api.test/cb',
        state: 'S',
        scopes: ['x'],
      }),
    );
    expect(url.searchParams.get('config_id')).toBe('999');
    expect(url.searchParams.has('scope')).toBe(false);
  });
  it('lists pages with their tokens and linked Instagram accounts, following paging', async () => {
    let n = 0;
    const f = fakeFetch(() =>
      ++n === 1
        ? {
            body: {
              data: [
                {
                  id: 'p1',
                  name: 'Shop One',
                  access_token: 'T1',
                  tasks: ['MODERATE'],
                  instagram_business_account: { id: 'ig1', username: 'shop1' },
                },
              ],
              paging: { cursors: { after: 'c1' }, next: 'https://next' },
            },
          }
        : { body: { data: [{ id: 'p2', name: 'Shop Two', access_token: 'T2' }] } },
    );
    const pages = await client(f.fn).listPages('USER');
    expect(pages).toEqual([
      {
        id: 'p1',
        name: 'Shop One',
        accessToken: 'T1',
        tasks: ['MODERATE'],
        instagram: { id: 'ig1', username: 'shop1' },
      },
      { id: 'p2', name: 'Shop Two', accessToken: 'T2', tasks: [], instagram: null },
    ]);
    expect(f.calls[1]!.url).toContain('after=c1');
  });
  it('reads debug_token with the app token', async () => {
    const f = fakeFetch(() => ({
      body: { data: { is_valid: true, scopes: ['pages_messaging'], expires_at: 0, app_id: '1' } },
    }));
    const d = await client(f.fn).debugToken(TOKEN);
    expect(d).toEqual({ isValid: true, scopes: ['pages_messaging'], expiresAt: null, appId: '1' });
    expect(f.calls[0]!.url).toContain(`access_token=1234567890%7C${SECRET}`);
  });
  it('exchanges a short-lived user token for a long-lived one', async () => {
    const f = fakeFetch(() => ({ body: { access_token: 'LONG', expires_in: 5184000 } }));
    expect(await client(f.fn).exchangeLongLived('SHORT')).toEqual({
      token: 'LONG',
      expiresIn: 5184000,
    });
    expect(f.calls[0]!.url).toContain('grant_type=fb_exchange_token');
  });
});
