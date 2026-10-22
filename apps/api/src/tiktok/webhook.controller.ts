import { Controller, Req } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { routes } from '@orderloop/contracts';
import { Endpoint, type AppRequest } from '../common/endpoint.js';
import { TikTokWebhookService } from './webhook.service.js';

/** TikTok sends from many addresses for every seller and bursts when it retries, so the per-address budget is far above the default. */
const BURST = { default: { limit: 1200, ttl: 60_000 } };

@Controller()
export class TikTokWebhookController {
  constructor(private readonly webhook: TikTokWebhookService) {}

  /** Answers 200 with an empty body (TikTok wants exactly that), or 401 for a signature that does not match. */
  @Throttle(BURST)
  @Endpoint(routes.tiktokWebhookReceive)
  async receive(@Req() req: AppRequest): Promise<void> {
    // `req.body` is the raw Buffer here (see configureApp): the signature is over those exact bytes.
    await this.webhook.receive(req.body, req.headers['authorization']);
  }
}
