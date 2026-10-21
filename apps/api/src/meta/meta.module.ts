import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module.js';
import { CredentialVault } from '../couriers/credential-vault.js';
import { OrdersModule } from '../orders/orders.module.js';
import { CallbacksService } from './callbacks.service.js';
import { ConnectionsService } from './connections.service.js';
import { DraftsService } from './drafts.service.js';
import { META_HTTP, META_NOW, MetaRuntime } from './meta.runtime.js';
import { MetaController } from './meta.controller.js';
import { OauthService } from './oauth.service.js';
import { MetaWebhookController } from './webhook.controller.js';
import { MetaWebhookService } from './webhook.service.js';

/** Meta (Facebook Page + Instagram) receive-only integration. See docs/meta.md. */
@Module({
  imports: [AuditModule, OrdersModule],
  controllers: [MetaController, MetaWebhookController],
  // META_HTTP and META_NOW are empty in production (real network, real clock); tests provide fakes.
  providers: [
    { provide: META_HTTP, useValue: {} },
    { provide: META_NOW, useValue: null },
    CredentialVault,
    MetaRuntime,
    ConnectionsService,
    OauthService,
    CallbacksService,
    MetaWebhookService,
    DraftsService,
  ],
})
export class MetaModule {}
