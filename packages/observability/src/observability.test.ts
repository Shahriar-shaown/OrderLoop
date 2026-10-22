import { EventEmitter } from 'node:events';
import { describe, expect, it } from 'vitest';
import {
  Registry,
  checkMetricsAuth,
  cleanLabelValue,
  createHttpMetrics,
  registerProcessMetrics,
  registerQueueMetrics,
  routeLabel,
  statusClass,
  statusFor,
  unhandledErrorEntry,
} from './index.js';

describe('Registry', () => {
  it('renders counters, gauges and histograms in the Prometheus text format', async () => {
    const r = new Registry();
    r.counter({ name: 'things_total', help: 'Things', labelNames: ['kind'] }).inc({ kind: 'a' }, 2);
    r.gauge({ name: 'level', help: 'Level' }).set({}, 3);
    const h = r.histogram({ name: 'lat_seconds', help: 'Latency', buckets: [0.1, 1] });
    h.observe({}, 0.05);
    h.observe({}, 0.5);
    h.observe({}, 5);
    const text = await r.render();
    expect(text).toContain('# TYPE things_total counter');
    expect(text).toContain('things_total{kind="a"} 2');
    expect(text).toContain('level 3');
    expect(text).toContain('lat_seconds_bucket{le="0.1"} 1');
    expect(text).toContain('lat_seconds_bucket{le="1"} 2');
    expect(text).toContain('lat_seconds_bucket{le="+Inf"} 3');
    expect(text).toContain('lat_seconds_count 3');
    expect(text.endsWith('\n')).toBe(true);
  });

  it('escapes and truncates label values, and strips control characters', () => {
    expect(cleanLabelValue('a"b\\c\nd')).toBe('a\\"b\\\\c d');
    expect(cleanLabelValue('x'.repeat(500)).length).toBe(80);
  });

  it('caps the label combinations of a metric and counts what it dropped', async () => {
    const r = new Registry();
    const c = r.counter({ name: 'capped_total', help: 'c', labelNames: ['id'], maxSeries: 5 });
    for (let i = 0; i < 1000; i++) c.inc({ id: `user-${i}` });
    expect(c.size).toBe(5);
    const text = await r.render();
    expect(text).toContain('orderloop_metrics_dropped_series_total{metric="capped_total"} 995');
    expect((text.match(/capped_total\{/g) ?? []).length).toBe(5);
  });

  it('caps histograms too', () => {
    const r = new Registry();
    const h = r.histogram({
      name: 'h_seconds',
      help: 'h',
      labelNames: ['id'],
      maxSeries: 3,
      buckets: [1],
    });
    for (let i = 0; i < 50; i++) h.observe({ id: String(i) }, 0.1);
    expect(h.size).toBe(3);
  });

  it('rejects invalid names, reserved label names and duplicates', () => {
    const r = new Registry();
    expect(() => r.counter({ name: 'bad name', help: 'x' })).toThrow(/invalid metric name/);
    expect(() => r.counter({ name: 'ok', help: 'x', labelNames: ['bad-label'] })).toThrow(/label/);
    expect(() => r.histogram({ name: 'hh', help: 'x', labelNames: ['le'], buckets: [1] })).toThrow(
      /le/,
    );
    r.counter({ name: 'dup', help: 'x' });
    expect(() => r.counter({ name: 'dup', help: 'x' })).toThrow(/already registered/);
  });

  it('ignores negative or non-finite increments and observations', async () => {
    const r = new Registry();
    const c = r.counter({ name: 'n_total', help: 'n' });
    c.inc({}, -1);
    c.inc({}, Number.NaN);
    expect(await r.render()).not.toMatch(/^n_total /m);
  });

  it('a failing gauge collector does not fail the scrape', async () => {
    const r = new Registry();
    r.gauge({ name: 'broken', help: 'b' }).setCollector(() => {
      throw new Error('redis down');
    });
    r.gauge({ name: 'fine', help: 'f' }).set({}, 1);
    const text = await r.render();
    expect(text).toContain('fine 1');
    expect(text).not.toMatch(/^broken /m);
  });
});

describe('HTTP metrics', () => {
  function run(
    mw: ReturnType<typeof createHttpMetrics>,
    req: { method: string; route?: { path?: unknown }; baseUrl?: string; url?: string },
    status: number,
  ) {
    const res = Object.assign(new EventEmitter(), { statusCode: status });
    mw(req, res as never, () => undefined);
    res.emit('finish');
    res.emit('close'); // a response emits both; it is counted once
  }

  it('labels by route template, never by the concrete URL', async () => {
    const r = new Registry();
    const mw = createHttpMetrics(r);
    run(
      mw,
      {
        method: 'GET',
        route: { path: '/v1/orders/:id' },
        url: '/v1/orders/0192e3a4-1111-7000-8000-000000000001?token=abc',
      },
      200,
    );
    run(
      mw,
      {
        method: 'GET',
        route: { path: '/v1/orders/:id' },
        url: '/v1/orders/0192e3a4-2222-7000-8000-000000000002',
      },
      404,
    );
    run(mw, { method: 'POST', route: { path: '/v1/auth/login' }, url: '/v1/auth/login' }, 500);
    run(mw, { method: 'GET', url: '/wp-admin/setup.php?email=a@b.c' }, 404);
    const text = await r.render();
    expect(text).toContain(
      'orderloop_http_requests_total{method="GET",route="/v1/orders/:id",status_class="2xx"} 1',
    );
    expect(text).toContain(
      'orderloop_http_requests_total{method="GET",route="/v1/orders/:id",status_class="4xx"} 1',
    );
    expect(text).toContain(
      'orderloop_http_requests_total{method="POST",route="/v1/auth/login",status_class="5xx"} 1',
    );
    expect(text).toContain('route="unmatched"');
    expect(text).not.toMatch(/0192e3a4|token=|wp-admin|a@b\.c/);
    expect(text).toContain('orderloop_http_requests_in_flight 0');
  });

  it('keeps the series count bounded under a scan of random paths and odd methods', async () => {
    const r = new Registry();
    const mw = createHttpMetrics(r);
    for (let i = 0; i < 3000; i++) run(mw, { method: `X${i}`, url: `/random/${i}` }, 404);
    const text = await r.render();
    const series = (text.match(/^orderloop_http_requests_total\{/gm) ?? []).length;
    expect(series).toBeLessThanOrEqual(2);
    expect(text).toContain('method="OTHER"');
  });

  it('maps status codes to classes', () => {
    expect(statusClass(204)).toBe('2xx');
    expect(statusClass(503)).toBe('5xx');
    expect(statusClass(0)).toBe('other');
    expect(routeLabel({ method: 'GET', route: { path: 42 } })).toBe('unmatched');
  });
});

describe('process metrics', () => {
  it('exposes process metrics and build info and nothing user-specific', async () => {
    const r = new Registry();
    const handle = registerProcessMetrics(r, { service: 'orderloop-test', version: '1.2.3' });
    const text = await r.render();
    handle.stop();
    expect(text).toContain('# TYPE process_cpu_seconds_total counter');
    expect(text).toContain('process_resident_memory_bytes');
    expect(text).toContain('nodejs_eventloop_lag_seconds{quantile="0.99"}');
    expect(text).toContain('orderloop_build_info{service="orderloop-test",version="1.2.3"');
  });
});

describe('queue metrics', () => {
  it('reports counts per state and the age of the oldest waiting job, labelled by queue name only', async () => {
    const r = new Registry();
    const now = 1_000_000;
    registerQueueMetrics(
      r,
      {
        imports: {
          getJobCounts: async () => ({ waiting: 3, active: 1, delayed: 0, failed: 2, paused: 0 }),
          getWaiting: async () => [{ timestamp: now - 42_000 }],
        },
        automation: {
          getJobCounts: async () => ({ waiting: 0, failed: 7 }),
          getWaiting: async () => [],
        },
      },
      { now: () => now },
    );
    const text = await r.render();
    expect(text).toContain('orderloop_queue_jobs{queue="imports",state="waiting"} 3');
    expect(text).toContain('orderloop_queue_jobs{queue="automation",state="failed"} 7');
    expect(text).toContain('orderloop_queue_oldest_waiting_age_seconds{queue="imports"} 42');
    expect(text).toContain('orderloop_queue_oldest_waiting_age_seconds{queue="automation"} 0');
  });

  it('caches the Redis reads for a few seconds, and omits the series when Redis fails', async () => {
    const r = new Registry();
    let calls = 0;
    let t = 0;
    let fail = false;
    registerQueueMetrics(
      r,
      {
        q: {
          getJobCounts: async () => {
            calls++;
            if (fail) throw new Error('down');
            return { waiting: 1 };
          },
          getWaiting: async () => [],
        },
      },
      { now: () => t, cacheMs: 5000 },
    );
    await r.render();
    await r.render();
    expect(calls).toBe(1);
    t = 6000;
    fail = true;
    const text = await r.render();
    expect(text).not.toContain('orderloop_queue_jobs{');
  });
});

describe('metrics auth', () => {
  const token = 'a-long-enough-token-value';
  it('is disabled (404) without a configured token', () => {
    expect(checkMetricsAuth(undefined, `Bearer ${token}`)).toBe('disabled');
    expect(statusFor('disabled')).toBe(404);
  });
  it('requires the exact bearer token', () => {
    expect(checkMetricsAuth(token, undefined)).toBe('missing');
    expect(checkMetricsAuth(token, 'Basic abc')).toBe('invalid');
    expect(checkMetricsAuth(token, 'Bearer nope')).toBe('invalid');
    expect(checkMetricsAuth(token, `Bearer ${token}x`)).toBe('invalid');
    expect(checkMetricsAuth(token, `bearer ${token}`)).toBe('invalid');
    expect(checkMetricsAuth(token, `Bearer ${token}`)).toBe('ok');
    expect(checkMetricsAuth(token, [`Bearer ${token}`])).toBe('ok');
    expect(statusFor('invalid')).toBe(401);
    expect(statusFor('ok')).toBe(200);
  });
});

describe('unhandledErrorEntry', () => {
  const scrub = (t: string) => t.replace(/secret-\w+/g, '[REDACTED]');
  it('has the stable event field, the service and no request data', () => {
    const err = new TypeError('boom secret-abc123');
    const e = unhandledErrorEntry(
      'orderloop-api',
      'uncaughtException',
      err,
      scrub,
      () => new Date(0),
    );
    expect(e).toMatchObject({
      event: 'unhandled_error',
      level: 'error',
      service: 'orderloop-api',
      source: 'uncaughtException',
      errorName: 'TypeError',
      time: '1970-01-01T00:00:00.000Z',
    });
    expect(JSON.stringify(e)).not.toContain('secret-abc123');
    expect(e.stack?.split('\n').length).toBeLessThanOrEqual(8);
  });
  it('copes with non-Error values and truncates long messages', () => {
    expect(unhandledErrorEntry('w', 's', 'plain string', scrub).errorName).toBe('string');
    expect(unhandledErrorEntry('w', 's', new Error('x'.repeat(5000)), scrub).message.length).toBe(
      300,
    );
  });
});
