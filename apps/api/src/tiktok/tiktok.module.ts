import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module.js';
import { CredentialVault } from '../couriers/credential-vault.js';
import { MetricsService } from '../metrics/metrics.service.js';
import { TikTokConnectionsService } from './connections.service.js';
import { TikTokMockService } from './mock.service.js';
import { TikTokOauthService } from './oauth.service.js';
import { TikTokOrdersService } from './orders.service.js';
import { TikTokSkuLinksService } from './sku-links.service.js';
import { TIKTOK_METRICS } from './tiktok.providers.js';
import { TikTokController } from './tiktok.controller.js';
import { TIKTOK_HTTP, TIKTOK_NOW, TikTokRuntime } from './tiktok.runtime.js';
import { TikTokWebhookController } from './webhook.controller.js';
import { TikTokWebhookService } from './webhook.service.js';

/** TikTok Shop: read-only order mirror, SKU links and exactly-once stock reservations. See docs/tiktok-shop.md. */
@Module({
  imports: [AuditModule],
  controllers: [TikTokController, TikTokWebhookController],
  // TIKTOK_HTTP and TIKTOK_NOW are empty in production (real network, real clock); tests provide fakes.
  providers: [
    { provide: TIKTOK_HTTP, useValue: {} },
    { provide: TIKTOK_NOW, useValue: null },
    {
      provide: TIKTOK_METRICS,
      inject: [MetricsService],
      useFactory: (m: MetricsService) => m.tiktok,
    },
    CredentialVault,
    TikTokRuntime,
    TikTokConnectionsService,
    TikTokOauthService,
    TikTokMockService,
    TikTokOrdersService,
    TikTokSkuLinksService,
    TikTokWebhookService,
  ],
})
export class TikTokModule {}
