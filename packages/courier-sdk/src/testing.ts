import type { FetchLike } from './http.js';

export interface Recorded {
  method: string;
  url: string;
  path: string;
  headers: Record<string, string>;
  body: unknown;
}

interface Plain {
  status?: number;
  body?: unknown;
  headers?: Record<string, string>;
  raw?: string;
}
type Reply = Plain | Error | ((r: Recorded) => Plain | Error | Promise<Plain | Error>);

/**
 * A fake network for tests: routes by "METHOD /path" (a path prefix match, first hit wins), records every request, and
 * answers with canned JSON. Nothing here touches the real network.
 */
export function fakeNetwork(routes: Record<string, Reply | Reply[]>) {
  const requests: Recorded[] = [];
  const queues = new Map<string, Reply[]>();
  for (const [k, v] of Object.entries(routes)) queues.set(k, Array.isArray(v) ? [...v] : [v]);
  const fetch: FetchLike = async (url, init) => {
    const u = new URL(url);
    const headers: Record<string, string> = {};
    new Headers(init.headers as Record<string, string>).forEach(
      (v, k) => (headers[k.toLowerCase()] = v),
    );
    const rec: Recorded = {
      method: String(init.method ?? 'GET'),
      url,
      path: u.pathname + u.search,
      headers,
      body: init.body ? JSON.parse(String(init.body)) : undefined,
    };
    requests.push(rec);
    const key = [...queues.keys()].find((k) => {
      const [m, ...p] = k.split(' ');
      return m === rec.method && rec.path.startsWith(p.join(' '));
    });
    if (!key)
      return new Response(
        JSON.stringify({ message: `no fake route for ${rec.method} ${rec.path}` }),
        { status: 599 },
      );
    const q = queues.get(key)!;
    const next = q.length > 1 ? q.shift()! : q[0]!;
    const reply = typeof next === 'function' ? await next(rec) : next;
    if (reply instanceof Error) throw reply;
    return new Response(reply.raw ?? JSON.stringify(reply.body ?? {}), {
      status: reply.status ?? 200,
      headers: { 'content-type': 'application/json', ...reply.headers },
    });
  };
  return { fetch, requests };
}

/** An error shaped like the ones fetch throws for a timeout and a refused connection. */
export const timeoutError = () => Object.assign(new Error('timed out'), { name: 'TimeoutError' });
export const refusedError = () =>
  Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } });
export const resetError = () =>
  Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNRESET' } });
