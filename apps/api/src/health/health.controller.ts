import { Controller, Get, HttpCode, Res } from '@nestjs/common';
import type { LiveResponse, ReadyResponse } from '@orderloop/contracts';
import type { Response } from 'express';
import { HealthService } from './health.service.js';

@Controller('health')
export class HealthController {
  constructor(private readonly health: HealthService) {}

  @Get('live')
  @HttpCode(200)
  live(): LiveResponse {
    return { status: 'ok' };
  }

  @Get('ready')
  async ready(@Res({ passthrough: true }) res: Response): Promise<ReadyResponse> {
    const result = await this.health.check();
    if (result.status !== 'ok') res.status(503);
    return result;
  }
}
