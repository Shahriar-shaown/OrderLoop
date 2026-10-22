import { request } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Registry } from '@orderloop/observability';
import { afterEach, describe, expect, it } from 'vitest';
import { probeWorker, startHealthServer, type HealthDeps } from './health-server.js';
import { createWorkerMetrics } from './worker-metrics.js';

const TOKEN = 'a-long-enough-metrics-token';
const NOW = Date.parse('2026-10-21T12:00:00Z');

function deps(over: Partial<HealthDeps> = {}): HealthDeps {
  return {
    redis: { ping: async () => 'PONG' },
    db: { ping: async () => undefined },
    lastHeartbeatAt: () => new Date(NOW - 10_000),
    registry: new Registry(),
    metricsToken: TOKEN,
    now: () => NOW,
    probeTimeoutMs: 100,
    ...over,
  };
}

function get(port: number, path: string, headers: Record<string, string> = {}) {
  return new Promise<{ status: number; body: string }>((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, path, headers }, (res) => {
      let body = '';
      res.on('data', (c: Buffer) => (body += c));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
    });
    req.on('error', reject);
    req.end();
  });
}

describe('probeWorker', () => {
  it('is ok when Redis, PostgreSQL and the heartbeat are fine', async () => {
    expect(await probeWorker(deps())).toEqual({
      status: 'ok',
      checks: { redis: 'up', postgres: 'up', heartbeat: 'up' },
    });
  });
  it('names the failing dependency', async () => {
    const r = await probeWorker(
      deps({ redis: { ping: async () => Promise.reject(new Error('ECONNREFUSED secret-host')) } }),
    );
    expect(r.status).toBe('degraded');
    expect(r.checks).toEqual({ redis: 'down', postgres: 'up', heartbeat: 'up' });
    expect(JSON.stringify(r)).not.toContain('secret-host');
  });
  it('treats a hung dependency as down after the timeout', async () => {
    const r = await probeWorker(deps({ db: { ping: () => new Promise(() => undefined) } }));
    expect(r.checks.postgres).toBe('down');
  });
  it('is degraded with no heartbeat yet, or a stale one', async () => {
    expect((await probeWorker(deps({ lastHeartbeatAt: () => undefined }))).checks.heartbeat).toBe(
      'down',
    );
    expect(
      (await probeWorker(deps({ lastHeartbeatAt: () => new Date(NOW - 91_000) }))).checks.heartbeat,
    ).toBe('down');
  });
});

describe('worker health server', () => {
  const servers: { close(): unknown }[] = [];
  afterEach(() => {
    servers.splice(0).forEach((s) => s.close());
  });
  async function start(d: HealthDeps) {
    const server = await startHealthServer(0, d);
    servers.push(server);
    return (server.address() as AddressInfo).port;
  }

  it('answers liveness without touching dependencies', async () => {
    const port = await start(deps({ redis: { ping: () => Promise.reject(new Error('x')) } }));
    expect(await get(port, '/health/live')).toEqual({ status: 200, body: '{"status":"ok"}' });
  });

  it('answers readiness 200, then 503 when Redis is down', async () => {
    const ok = await start(deps());
    expect((await get(ok, '/health/ready')).status).toBe(200);
    const bad = await start(deps({ redis: { ping: () => Promise.reject(new Error('x')) } }));
    const res = await get(bad, '/health/ready');
    expect(res.status).toBe(503);
    expect(JSON.parse(res.body).checks.redis).toBe('down');
  });

  it('serves /metrics only with the bearer token, and 404 when no token is configured', async () => {
    const d = deps();
    const port = await start(d);
    expect((await get(port, '/metrics')).status).toBe(401);
    expect((await get(port, '/metrics', { Authorization: 'Bearer wrong' })).status).toBe(401);
    expect((await get(port, '/metrics?token=' + TOKEN)).status).toBe(401);
    const ok = await get(port, '/metrics', { Authorization: `Bearer ${TOKEN}` });
    expect(ok.status).toBe(200);
    const off = await start(deps({ metricsToken: undefined }));
    expect((await get(off, '/metrics', { Authorization: `Bearer ${TOKEN}` })).status).toBe(404);
  });

  it('exposes worker metrics: jobs per queue and result, readiness and own heartbeat age', async () => {
    const m = createWorkerMetrics(
      {
        redis: { ping: async () => 'PONG' },
        db: { ping: async () => undefined },
        lastHeartbeatAt: () => new Date(NOW - 10_000),
      },
      () => NOW,
    );
    const handlers: Record<string, (j?: { processedOn?: number; finishedOn?: number }) => void> =
      {};
    m.instrument('imports', {
      on: ((event: string, fn: never) => {
        handlers[event] = fn;
      }) as never,
    });
    handlers.completed!({ processedOn: 1000, finishedOn: 3000 });
    handlers.failed!({ processedOn: 1000, finishedOn: 1500 });
    handlers.failed!(undefined);
    const text = await m.registry.render();
    m.stop();
    expect(text).toContain('orderloop_worker_jobs_total{queue="imports",result="completed"} 1');
    expect(text).toContain('orderloop_worker_jobs_total{queue="imports",result="failed"} 2');
    expect(text).toContain('orderloop_worker_job_duration_seconds_count{queue="imports"} 2');
    expect(text).toContain('orderloop_worker_ready{check="redis"} 1');
    expect(text).toContain('orderloop_worker_own_heartbeat_age_seconds 10');
    expect(text).not.toMatch(/tenant|email|@/i);
  });

  it('404s anything else and refuses methods other than GET/HEAD', async () => {
    const port = await start(deps());
    expect((await get(port, '/')).status).toBe(404);
    expect((await get(port, '/health')).status).toBe(404);
  });
});
