import { CourierError } from './errors.js';

export type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

export interface HttpOptions {
  baseUrl: string;
  fetch?: FetchLike | undefined;
  /** Per request, including reading the reply. */
  timeoutMs?: number | undefined;
  userAgent?: string | undefined;
  sleep?: ((ms: number) => Promise<void>) | undefined;
  /** Ask before each request (a rate limiter). */
  beforeRequest?: (() => Promise<void>) | undefined;
}

export interface RequestOptions {
  method: 'GET' | 'POST';
  path: string;
  headers?: Record<string, string> | undefined;
  body?: unknown;
  query?: Record<string, string | number> | undefined;
  /**
   * `idempotent`: safe to repeat (reads), so transient failures are retried with backoff.
   * `create`: may have side effects. Never retried after an unknown outcome; a refused (429) or never-sent request may be.
   */
  kind: 'idempotent' | 'create';
  timeoutMs?: number | undefined;
}

const REFUSED_BEFORE_SENDING = new Set([
  'ENOTFOUND',
  'ECONNREFUSED',
  'EAI_AGAIN',
  'ERR_INVALID_URL',
]);
const RETRY_DELAYS_MS = [500, 1500];
/** A provider asking us to wait longer than this is told to the caller (`rate_limited`), not slept through or retried early. */
const MAX_RETRY_AFTER_SECONDS = 30;

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** `Retry-After` is whole seconds or an HTTP date. Seconds to wait, or undefined when absent, unreadable or already past. */
export function parseRetryAfter(
  value: string | null,
  nowMs: number = Date.now(),
): number | undefined {
  const text = value?.trim();
  if (!text) return undefined;
  const seconds = /^\d+$/.test(text) ? Number(text) : Math.ceil((Date.parse(text) - nowMs) / 1000);
  return Number.isFinite(seconds) && seconds > 0 ? seconds : undefined;
}

/** The most useful short sentence in a provider's error body, with nothing that could be a secret. */
export function providerMessage(body: unknown): string | undefined {
  if (!body || typeof body !== 'object') return undefined;
  const b = body as Record<string, unknown>;
  const text = [b['message'], b['error'], b['error_description']].find(
    (v) => typeof v === 'string',
  ) as string | undefined;
  return text ? text.replace(/\s+/g, ' ').slice(0, 300) : undefined;
}

function fieldErrors(body: unknown): { field: string; message: string }[] {
  if (!body || typeof body !== 'object') return [];
  const errors = (body as Record<string, unknown>)['errors'];
  if (!errors || typeof errors !== 'object') return [];
  return Object.entries(errors as Record<string, unknown>).flatMap(([field, v]) =>
    (Array.isArray(v) ? v : [v])
      .filter((m): m is string => typeof m === 'string')
      .map((message) => ({ field, message: message.slice(0, 200) })),
  );
}

/**
 * A small HTTP client for provider APIs. It never follows redirects (a redirect would forward our credentials to another
 * host), always times out, understands `Retry-After`, and turns every failure into a `CourierError` that says whether
 * the request might have been carried out.
 */
export class Http {
  private readonly fetchImpl: FetchLike;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(private readonly options: HttpOptions) {
    this.fetchImpl = options.fetch ?? ((url, init) => fetch(url, init));
    this.sleep = options.sleep ?? defaultSleep;
  }

  async request<T = unknown>(r: RequestOptions): Promise<T> {
    const attempts = r.kind === 'idempotent' ? RETRY_DELAYS_MS.length + 1 : 2;
    let last: CourierError | undefined;
    for (let attempt = 0; attempt < attempts; attempt++) {
      try {
        return await this.once<T>(r);
      } catch (error) {
        if (!(error instanceof CourierError)) throw error;
        last = error;
        const canRetry =
          r.kind === 'idempotent'
            ? error.retryable
            : // A booking may be repeated only when the provider refused it outright or it never left.
              error.kind === 'rate_limited' ||
              (error.kind === 'unavailable' && !error.outcomeUnknown);
        const asked = error.retryAfterSeconds;
        if (!canRetry || attempt === attempts - 1) throw error;
        // Retrying before the provider asked would only be refused again (and may count against us).
        if (asked !== undefined && asked > MAX_RETRY_AFTER_SECONDS) throw error;
        await this.sleep(asked !== undefined ? asked * 1000 : (RETRY_DELAYS_MS[attempt] ?? 1500));
      }
    }
    throw last ?? new CourierError('unexpected', 'The request did not run');
  }

  private async once<T>(r: RequestOptions): Promise<T> {
    await this.options.beforeRequest?.();
    const url = new URL(r.path, this.options.baseUrl);
    for (const [k, v] of Object.entries(r.query ?? {})) url.searchParams.set(k, String(v));
    const timeoutMs = r.timeoutMs ?? this.options.timeoutMs ?? 15_000;
    let response: Response;
    try {
      response = await this.fetchImpl(url.toString(), {
        method: r.method,
        redirect: 'manual',
        signal: AbortSignal.timeout(timeoutMs),
        headers: {
          Accept: 'application/json',
          ...(r.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
          'User-Agent': this.options.userAgent ?? 'OrderLoop-courier/1.0',
          ...r.headers,
        },
        ...(r.body !== undefined ? { body: JSON.stringify(r.body) } : {}),
      });
    } catch (error) {
      const name = (error as { name?: string }).name;
      const code = ((error as { cause?: { code?: string } }).cause?.code ??
        (error as { code?: string }).code) as string | undefined;
      if (name === 'TimeoutError' || name === 'AbortError')
        throw new CourierError(
          'unavailable',
          `The courier did not answer within ${Math.round(timeoutMs / 1000)} seconds`,
          {
            outcomeUnknown: r.kind === 'create',
          },
        );
      throw new CourierError('unavailable', 'Could not reach the courier', {
        outcomeUnknown: r.kind === 'create' && !(code && REFUSED_BEFORE_SENDING.has(code)),
      });
    }

    let text: string;
    try {
      text = await response.text();
    } catch {
      throw new CourierError('unavailable', 'The courier reply was cut off', {
        status: response.status,
        outcomeUnknown: r.kind === 'create',
      });
    }
    let body: unknown;
    try {
      body = text ? JSON.parse(text) : {};
    } catch {
      body = undefined;
    }

    if (response.status >= 300 && response.status < 400)
      throw new CourierError(
        'unexpected',
        'The courier tried to redirect the request, which is refused',
        {
          status: response.status,
        },
      );
    if (response.ok) {
      if (body === undefined)
        throw new CourierError('unavailable', 'The courier reply was not understood', {
          status: response.status,
          outcomeUnknown: r.kind === 'create',
        });
      return body as T;
    }

    const message = providerMessage(body);
    const status = response.status;
    if (status === 401)
      throw new CourierError('auth', message ?? 'The courier rejected the credentials', { status });
    if (status === 402 || status === 403)
      throw new CourierError(
        'forbidden',
        message ?? 'The courier account is not allowed to do this',
        { status },
      );
    if (status === 404)
      throw new CourierError('not_found', message ?? 'The courier has no such record', { status });
    if (status === 429) {
      throw new CourierError('rate_limited', message ?? 'The courier is rate limiting requests', {
        status,
        retryAfterSeconds: parseRetryAfter(response.headers.get('retry-after')),
        outcomeUnknown: false,
      });
    }
    if (status === 400 || status === 409 || status === 422)
      throw new CourierError('validation', message ?? 'The courier refused the request', {
        status,
        fields: fieldErrors(body),
        // A conflict on a booking usually means an earlier attempt went through: the caller must look, not assume it failed.
        outcomeUnknown: status === 409 && r.kind === 'create',
      });
    if (status >= 500)
      throw new CourierError('unavailable', message ?? 'The courier had a problem', {
        status,
        outcomeUnknown: r.kind === 'create',
      });
    throw new CourierError('unexpected', message ?? `The courier answered ${status}`, { status });
  }
}

/**
 * A token bucket: at most `perMinute` requests start per rolling minute. When the bucket is empty it waits (up to
 * `maxWaitMs`) rather than sending a request that would be refused, and gives up with `rate_limited` if the wait is too long.
 */
export class RateLimiter {
  private readonly starts: number[] = [];

  constructor(
    private readonly perMinute: number,
    private readonly now: () => number = Date.now,
    private readonly sleep: (ms: number) => Promise<void> = defaultSleep,
    private readonly maxWaitMs = 10_000,
  ) {}

  async acquire(): Promise<void> {
    for (;;) {
      const t = this.now();
      while (this.starts.length && this.starts[0]! <= t - 60_000) this.starts.shift();
      if (this.starts.length < this.perMinute) {
        this.starts.push(t);
        return;
      }
      const wait = this.starts[0]! + 60_000 - t;
      if (wait > this.maxWaitMs)
        throw new CourierError(
          'rate_limited',
          'Too many courier requests right now. Try again in a minute.',
          {
            retryAfterSeconds: Math.ceil(wait / 1000),
            outcomeUnknown: false,
          },
        );
      await this.sleep(wait);
    }
  }
}
