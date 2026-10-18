import { Controller, Req, Res } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { routes, type ParsedInput } from '@orderloop/contracts';
import type { Response } from 'express';
import { Endpoint, Input, type AppRequest } from '../common/endpoint.js';
import { WebhooksService } from './webhooks.service.js';

@Controller()
export class WebhooksController {
  constructor(private readonly webhooks: WebhooksService) {}

  /** Couriers send from a handful of addresses for every seller, so the per-address budget is far above the default. */
  @Throttle({ default: { limit: 1200, ttl: 60_000 } })
  @Endpoint(routes.courierWebhook)
  async receive(
    @Input() input: ParsedInput<typeof routes.courierWebhook>,
    @Req() req: AppRequest,
    @Res({ passthrough: true }) res: Response,
  ): Promise<{ status: string }> {
    const reply = await this.webhooks.handle(
      input.params.provider,
      input.params.tenantId,
      input.params.connectionId,
      req.headers,
      input.body,
    );
    res.status(reply.status);
    for (const [name, value] of Object.entries(reply.headers)) res.setHeader(name, value);
    return reply.body;
  }
}
