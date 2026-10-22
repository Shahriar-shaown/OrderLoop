import { Global, Injectable, Module, type NestMiddleware } from '@nestjs/common';
import type { NextFunction, Request, Response } from 'express';
import { HealthModule } from '../health/health.module.js';
import { MetricsService } from './metrics.service.js';

/** Counts and times every request the framework routes (see `createHttpMetrics`). */
@Injectable()
export class HttpMetricsMiddleware implements NestMiddleware {
  constructor(private readonly metrics: MetricsService) {}
  use(req: Request, res: Response, next: NextFunction): void {
    this.metrics.httpMiddleware(req, res, next);
  }
}

@Global()
@Module({
  imports: [HealthModule],
  providers: [MetricsService, HttpMetricsMiddleware],
  exports: [MetricsService],
})
export class MetricsModule {}
