import { randomUUID } from 'node:crypto';

export interface FakePage {
  id: string;
  name: string;
  token: string;
  tasks?: string[];
  instagram?: { id: string; username: string };
}

export interface GraphCall {
  method: string;
  path: string;
  query: URLSearchParams;
  body: URLSearchParams;
}

type Failure = { status?: number; code: number; message?: string };

/**
 * A fake Meta Graph API (the injected `fetch`): nothing real is ever called. Configure `pages`, `fail` (by step) and `debug`;
 * every request is recorded in `calls`, so a test can assert what was sent and where the tokens travelled.
 */
export function fakeGraph() {
  const g = {
    calls: [] as GraphCall[],
    metaUserId: 'META_USER_1',
    goodCode: 'GOOD_CODE',
    pages: [] as FakePage[],
    /** Fail the next calls of a step: oauth | long | me | accounts | subscribe | unsubscribe | debug */
    fail: {} as Record<string, Failure | undefined>,
    /** Fail the subscribe call of one Page only (by Page id). */
    failPage: {} as Record<string, Failure | undefined>,
    debug: {
      is_valid: true,
      scopes: ['pages_messaging', 'instagram_manage_messages', 'pages_show_list'],
    } as Record<string, unknown>,
    userToken: `EAAUSERLONG${randomUUID().replaceAll('-', '')}`,
    fetch: (async (url: string, init: { method?: string; body?: string } = {}) => {
      const u = new URL(url);
      const call: GraphCall = {
        method: init.method ?? 'GET',
        path: u.pathname.replace(/^\/v[\d.]+\//, ''),
        query: u.searchParams,
        body: new URLSearchParams(init.body ?? ''),
      };
      g.calls.push(call);
      const params = (k: string) => call.query.get(k) ?? call.body.get(k);
      const ok = (body: unknown) => ({ ok: true, status: 200, json: async () => body }) as Response;
      const error = (f: Failure) =>
        ({
          ok: false,
          status: f.status ?? 400,
          json: async () => ({
            error: {
              message: f.message ?? 'graph says no',
              type: 'OAuthException',
              code: f.code,
              fbtrace_id: 'x',
            },
          }),
        }) as Response;
      const step = (() => {
        if (call.path === 'oauth/access_token') return params('code') ? 'oauth' : 'long';
        if (call.path === 'me') return 'me';
        if (call.path === 'me/accounts') return 'accounts';
        if (call.path === 'debug_token') return 'debug';
        if (call.path.endsWith('/subscribed_apps'))
          return call.method === 'DELETE' ? 'unsubscribe' : 'subscribe';
        return 'unknown';
      })();
      const f =
        g.fail[step] ?? (step === 'subscribe' ? g.failPage[call.path.split('/')[0]!] : undefined);
      if (f) return error(f);
      switch (step) {
        case 'oauth':
          return params('code') === g.goodCode
            ? ok({ access_token: 'EAASHORT' + 'x'.repeat(30) })
            : error({ code: 100, message: 'bad verification code' });
        case 'long':
          return ok({ access_token: g.userToken, expires_in: 5_183_999 });
        case 'me':
          return ok({ id: g.metaUserId, name: 'Meta Person' });
        case 'accounts':
          return ok({
            data: g.pages.map((p) => ({
              id: p.id,
              name: p.name,
              access_token: p.token,
              tasks: p.tasks ?? ['MODERATE', 'MESSAGING'],
              ...(p.instagram ? { instagram_business_account: p.instagram } : {}),
            })),
          });
        case 'subscribe':
        case 'unsubscribe':
          return ok({ success: true });
        case 'debug':
          return ok({ data: g.debug });
        default:
          return error({ code: 100, message: 'unknown' });
      }
    }) as unknown as typeof fetch,
    called: (step: string) =>
      g.calls.filter((c) =>
        step === 'subscribe'
          ? c.path.endsWith('/subscribed_apps') && c.method === 'POST'
          : step === 'unsubscribe'
            ? c.method === 'DELETE'
            : c.path === step,
      ),
  };
  return g;
}
export type FakeGraph = ReturnType<typeof fakeGraph>;

let n = 0;
export const newPage = (over: Partial<FakePage> = {}): FakePage => {
  n += 1;
  const id = over.id ?? `${Date.now()}${n}${Math.floor(Math.random() * 1000)}`;
  return {
    id,
    name: over.name ?? `Shop Page ${n}`,
    token: over.token ?? `EAAPAGE${id}${randomUUID().replaceAll('-', '')}`,
    ...(over.instagram ? { instagram: over.instagram } : {}),
    ...(over.tasks ? { tasks: over.tasks } : {}),
  };
};
