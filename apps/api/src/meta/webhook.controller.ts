import { Controller, Req, Res } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { routes, type ParsedInput } from '@orderloop/contracts';
import type { Response } from 'express';
import { Endpoint, Input, type AppRequest } from '../common/endpoint.js';
import { CallbacksService } from './callbacks.service.js';
import { MetaWebhookService } from './webhook.service.js';
import { MetaRuntime } from './meta.runtime.js';
import { ApiError } from '../common/api-error.js';

/** Meta sends from many addresses for every seller and bursts when it retries, so the per-address budget is far above the default. */
const BURST = { default: { limit: 1200, ttl: 60_000 } };

@Controller()
export class MetaWebhookController {
  constructor(
    private readonly webhook: MetaWebhookService,
    private readonly callbacks: CallbacksService,
    private readonly runtime: MetaRuntime,
  ) {}

  @Throttle(BURST)
  @Endpoint(routes.metaWebhookVerify)
  verify(
    @Input() input: ParsedInput<typeof routes.metaWebhookVerify>,
    @Res({ passthrough: true }) res: Response,
  ): string {
    const challenge = this.webhook.verify(input.query);
    res.type('text/plain');
    return challenge;
  }

  @Throttle(BURST)
  @Endpoint(routes.metaWebhookReceive)
  receive(@Req() req: AppRequest): Promise<{ status: string }> {
    // `req.body` is the raw Buffer here (see configureApp): the signature is over those exact bytes.
    return this.webhook.receive(req.body, req.headers['x-hub-signature-256']);
  }

  @Throttle({ default: { limit: 60, ttl: 60_000 } })
  @Endpoint(routes.metaDeauthorize)
  deauthorize(
    @Input() input: ParsedInput<typeof routes.metaDeauthorize>,
  ): Promise<Record<string, never>> {
    return this.callbacks.deauthorize(input.body.signed_request);
  }

  @Throttle({ default: { limit: 60, ttl: 60_000 } })
  @Endpoint(routes.metaDataDeletion)
  dataDeletion(
    @Input() input: ParsedInput<typeof routes.metaDataDeletion>,
  ): Promise<{ url: string; confirmation_code: string }> {
    return this.callbacks.deleteData(input.body.signed_request);
  }

  @Endpoint(routes.metaDataDeletionStatus)
  deletionStatus(@Input() input: ParsedInput<typeof routes.metaDataDeletionStatus>): {
    confirmationCode: string;
    status: 'completed';
  } {
    // Deletion is immediate, so a well-formed code always reads completed. The code reveals nothing (it is a keyed hash).
    if (!this.runtime.appSecret || !/^[0-9a-f]{24}$/.test(input.query.code))
      throw ApiError.notFound();
    return { confirmationCode: input.query.code, status: 'completed' };
  }
}
