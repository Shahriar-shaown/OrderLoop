import type { Registry } from './registry.js';

const KNOWN_METHODS = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS']);

export const HTTP_BUCKETS = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10];

export interface RequestLike {
  method: string;
  route?: { path?: unknown } | undefined;
  baseUrl?: string;
}
export interface ResponseLike {
  statusCode: number;
  once(event: 'finish' | 'close', listener: () => void): unknown;
}

/**
 * The route TEMPLATE the framework matched (`/v1/orders/:id`), never the URL: ids, emails, tokens and query strings never
 * become label values. An unmatched request (a scanner probing random paths) is the single value `unmatched`.
 */
export function routeLabel(req: RequestLike): string {
  const path = req.route?.path;
  if (typeof path !== 'string' || path.length === 0) return 'unmatched';
  return `${req.baseUrl ?? ''}${path}`.slice(0, 80);
}

export function statusClass(status: number): string {
  return status >= 100 && status < 600 ? `${Math.floor(status / 100)}xx` : 'other';
}

/** Express/Nest middleware: counts requests and times them by method, route template and status class. */
export function createHttpMetrics(registry: Registry) {
  const total = registry.counter({
    name: 'orderloop_http_requests_total',
    help: 'HTTP requests handled, by method, route template and status class',
    labelNames: ['method', 'route', 'status_class'],
    maxSeries: 600,
  });
  const duration = registry.histogram({
    name: 'orderloop_http_request_duration_seconds',
    help: 'HTTP request duration in seconds, by method, route template and status class',
    labelNames: ['method', 'route', 'status_class'],
    maxSeries: 600,
    buckets: HTTP_BUCKETS,
  });
  const inFlight = registry.gauge({
    name: 'orderloop_http_requests_in_flight',
    help: 'HTTP requests currently being handled',
  });
  let current = 0;
  inFlight.setCollector((g) => g.set({}, current));

  return function httpMetrics(req: RequestLike, res: ResponseLike, next: () => void): void {
    const started = process.hrtime.bigint();
    current++;
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      current--;
      const labels = {
        method: KNOWN_METHODS.has(req.method) ? req.method : 'OTHER',
        route: routeLabel(req),
        status_class: statusClass(res.statusCode),
      };
      total.inc(labels);
      duration.observe(labels, Number(process.hrtime.bigint() - started) / 1e9);
    };
    res.once('finish', finish);
    res.once('close', finish);
    next();
  };
}
