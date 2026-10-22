import express from 'express';
import request from 'supertest';
import { Registry, createHttpMetrics } from '@orderloop/observability';
import { describe, expect, it } from 'vitest';
import { metricsHandler } from './metrics.endpoint.js';

const TOKEN = 'a-long-enough-metrics-token';

function app(token: string | undefined) {
  const registry = new Registry();
  const http = createHttpMetrics(registry);
  const server = express();
  server.use(http);
  server.get('/metrics', metricsHandler({ registry, token }));
  // Routes shaped like the real API, to prove templates (not URLs) become labels.
  server.get('/v1/orders/:id', (_req, res) => void res.json({ ok: true }));
  server.post('/v1/auth/login', (_req, res) => void res.status(500).json({ error: 'x' }));
  return server;
}

describe('GET /metrics', () => {
  it('does not exist (404) when METRICS_TOKEN is not set, even with a token', async () => {
    const s = app(undefined);
    await request(s).get('/metrics').expect(404);
    await request(s).get('/metrics').set('Authorization', `Bearer ${TOKEN}`).expect(404);
  });

  it('answers 401 without a token or with a wrong one', async () => {
    const s = app(TOKEN);
    const res = await request(s).get('/metrics').expect(401);
    expect(res.headers['www-authenticate']).toMatch(/Bearer/);
    await request(s).get('/metrics').set('Authorization', 'Bearer wrong').expect(401);
    await request(s).get('/metrics').set('Authorization', `Basic ${TOKEN}`).expect(401);
    await request(s)
      .get('/metrics?token=' + TOKEN)
      .expect(401); // never accepted in the URL
  });

  it('serves the Prometheus text format with the right token, uncached', async () => {
    const s = app(TOKEN);
    await request(s).get('/v1/orders/0192e3a4-1111-7000-8000-000000000001?email=a@b.c').expect(200);
    await request(s).post('/v1/auth/login').send({ email: 'someone@example.com' }).expect(500);
    const res = await request(s)
      .get('/metrics')
      .set('Authorization', `Bearer ${TOKEN}`)
      .expect(200);
    expect(res.headers['content-type']).toMatch(/text\/plain.*version=0\.0\.4/);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.text).toContain(
      'orderloop_http_requests_total{method="GET",route="/v1/orders/:id",status_class="2xx"} 1',
    );
    expect(res.text).toContain(
      'orderloop_http_requests_total{method="POST",route="/v1/auth/login",status_class="5xx"} 1',
    );
  });

  it('puts no id, email or token in any label or value', async () => {
    const s = app(TOKEN);
    await request(s).get('/v1/orders/0192e3a4-1111-7000-8000-000000000001?email=a@b.c&token=zzz');
    await request(s).get('/some/secret/path/with-a-token-abcdef0123456789');
    const res = await request(s).get('/metrics').set('Authorization', `Bearer ${TOKEN}`);
    expect(res.text).not.toMatch(/0192e3a4|a@b\.c|zzz|secret|abcdef0123456789|someone@/);
    expect(res.text).not.toContain(TOKEN);
  });
});
