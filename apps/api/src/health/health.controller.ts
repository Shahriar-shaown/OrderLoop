import { Controller, Res } from '@nestjs/common';
import { routes, type LiveResponse, type ReadyResponse } from '@orderloop/contracts';
import type { Response } from 'express';
import { Endpoint } from '../common/endpoint.js';
import { HealthService } from './health.service.js';

@Controller()
export class HealthController {
  constructor(private readonly health: HealthService) {}

  @Endpoint(routes.healthLive)
  live(): LiveResponse {
    return { status: 'ok' };
  }

  @Endpoint(routes.healthReady)
  async ready(@Res({ passthrough: true }) res: Response): Promise<ReadyResponse> {
    const result = await this.health.check();
    if (result.status !== 'ok') res.status(503);
    return result;
  }
}
