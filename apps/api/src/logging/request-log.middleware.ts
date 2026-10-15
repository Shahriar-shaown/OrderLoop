import { randomUUID } from 'node:crypto';
import { Inject, Injectable, type NestMiddleware } from '@nestjs/common';
import type { NextFunction, Response } from 'express';
import type { AppRequest } from '../common/endpoint.js';
import type { Logger } from './logger.js';
import { LOGGER } from './tokens.js';

const REQUEST_ID_RE = /^[A-Za-z0-9._-]{8,64}$/;

/**
 * One structured line per request. Deliberately logs no bodies, no query string (cursors and future links may carry
 * tokens), no headers, and no user agent: method, path, status, timing, caller ids and the request id are enough to
 * trace an incident.
 */
@Injectable()
export class RequestLogMiddleware implements NestMiddleware {
  constructor(@Inject(LOGGER) private readonly logger: Logger) {}

  use(req: AppRequest, res: Response, next: NextFunction): void {
    const incoming = req.headers['x-request-id'];
    // Only accept well-formed ids so a client cannot inject log-breaking content.
    const requestId =
      typeof incoming === 'string' && REQUEST_ID_RE.test(incoming) ? incoming : randomUUID();
    res.setHeader('x-request-id', requestId);
    const started = process.hrtime.bigint();

    res.on('finish', () => {
      const path = req.originalUrl.split('?')[0];
      const status = res.statusCode;
      const level =
        path?.startsWith('/health/') && status < 400
          ? 'debug'
          : status >= 500
            ? 'error'
            : status >= 400
              ? 'warn'
              : 'info';
      this.logger[level](
        {
          requestId,
          method: req.method,
          path,
          status,
          durationMs: Number((Number(process.hrtime.bigint() - started) / 1e6).toFixed(1)),
          ip: req.ip,
          ...(req.auth ? { userId: req.auth.userId, tenantId: req.auth.tenantId } : {}),
        },
        'request completed',
      );
    });
    next();
  }
}
