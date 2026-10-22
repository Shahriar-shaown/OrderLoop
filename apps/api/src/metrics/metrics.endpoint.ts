import { checkMetricsAuth, statusFor, type Registry } from '@orderloop/observability';
import type { Request, RequestHandler, Response } from 'express';

/**
 * GET /metrics for Prometheus. Answers 404 when no METRICS_TOKEN is configured (the endpoint does not exist), 401 without the
 * right `Authorization: Bearer` token, and the exposition text otherwise. A plain Express handler on purpose: it is not part of
 * the business API (no OpenAPI entry, no tenant, no session) and the AccessGuard never sees it.
 */
export function metricsHandler(deps: {
  registry: Registry;
  token: string | undefined;
}): RequestHandler {
  return async (req: Request, res: Response) => {
    const verdict = checkMetricsAuth(deps.token, req.headers.authorization);
    res.setHeader('Cache-Control', 'no-store');
    if (verdict !== 'ok') {
      res.status(statusFor(verdict));
      if (verdict === 'disabled') {
        res.type('text/plain').send('Not Found');
        return;
      }
      res.setHeader('WWW-Authenticate', 'Bearer realm="metrics"');
      res.type('text/plain').send('Unauthorized');
      return;
    }
    try {
      res
        .status(200)
        .type(deps.registry.contentType)
        .send(await deps.registry.render());
    } catch {
      res.status(500).type('text/plain').send('metrics unavailable');
    }
  };
}
