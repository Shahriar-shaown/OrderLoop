import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { checkMetricsAuth, statusFor, type Registry } from '@orderloop/observability';

export type CheckResult = 'up' | 'down';

export interface HealthDeps {
  redis: { ping(): Promise<unknown> };
  db: { ping(): Promise<void> };
  /** Time of the last heartbeat written to Redis, or undefined if none succeeded yet. */
  lastHeartbeatAt: () => Date | undefined;
  registry: Registry;
  /** METRICS_TOKEN: /metrics is a 404 without it, a 401 without the right bearer token. */
  metricsToken: string | undefined;
  now?: () => number;
  /** A heartbeat older than this means the loop that writes it is stuck (it beats every 30 s). Default 90 s. */
  heartbeatStaleMs?: number;
  probeTimeoutMs?: number;
}

const json = (res: ServerResponse, status: number, body: unknown) => {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
};

function withTimeout(fn: () => Promise<unknown>, ms: number): Promise<CheckResult> {
  let timer: NodeJS.Timeout | undefined;
  return Promise.race([
    fn().then(
      () => 'up' as const,
      () => 'down' as const,
    ),
    new Promise<CheckResult>((resolve) => {
      timer = setTimeout(() => resolve('down'), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}

/**
 * The worker's readiness: Redis answers, PostgreSQL answers, and this process's heartbeat loop has written within
 * `heartbeatStaleMs` (it is stuck otherwise). Always 200/503 with the failing check named, never an error detail.
 */
export async function probeWorker(deps: HealthDeps): Promise<{
  status: 'ok' | 'degraded';
  checks: Record<'redis' | 'postgres' | 'heartbeat', CheckResult>;
}> {
  const timeout = deps.probeTimeoutMs ?? 1500;
  const [redis, postgres] = await Promise.all([
    withTimeout(() => deps.redis.ping(), timeout),
    withTimeout(() => deps.db.ping(), timeout),
  ]);
  const last = deps.lastHeartbeatAt();
  const now = (deps.now ?? Date.now)();
  const heartbeat: CheckResult =
    last && now - last.getTime() <= (deps.heartbeatStaleMs ?? 90_000) ? 'up' : 'down';
  const checks = { redis, postgres, heartbeat };
  return {
    status: redis === 'up' && postgres === 'up' && heartbeat === 'up' ? 'ok' : 'degraded',
    checks,
  };
}

export function createHealthHandler(deps: HealthDeps) {
  return async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const path = (req.url ?? '').split('?')[0];
    if (req.method !== 'GET' && req.method !== 'HEAD')
      return json(res, 405, { status: 'method_not_allowed' });
    if (path === '/health/live') return json(res, 200, { status: 'ok' });
    if (path === '/health/ready') {
      const result = await probeWorker(deps);
      return json(res, result.status === 'ok' ? 200 : 503, result);
    }
    if (path === '/metrics') {
      const verdict = checkMetricsAuth(deps.metricsToken, req.headers.authorization);
      if (verdict !== 'ok') {
        res.writeHead(statusFor(verdict), {
          'Content-Type': 'text/plain',
          'Cache-Control': 'no-store',
          ...(verdict === 'disabled' ? {} : { 'WWW-Authenticate': 'Bearer realm="metrics"' }),
        });
        res.end(verdict === 'disabled' ? 'Not Found' : 'Unauthorized');
        return;
      }
      try {
        const body = await deps.registry.render();
        res.writeHead(200, {
          'Content-Type': deps.registry.contentType,
          'Cache-Control': 'no-store',
        });
        res.end(body);
      } catch {
        res.writeHead(500, { 'Content-Type': 'text/plain' });
        res.end('metrics unavailable');
      }
      return;
    }
    json(res, 404, { status: 'not_found' });
  };
}

/** Listens on all interfaces (the container's network is the boundary): publish the port nowhere, scrape it from the monitoring network. */
export function startHealthServer(port: number, deps: HealthDeps): Promise<Server> {
  const handler = createHealthHandler(deps);
  const server = createServer((req, res) => {
    handler(req, res).catch(() => {
      if (!res.headersSent) json(res, 500, { status: 'error' });
      else res.end();
    });
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '0.0.0.0', () => resolve(server));
  });
}
