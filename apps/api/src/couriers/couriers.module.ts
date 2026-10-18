import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module.js';
import { OrdersModule } from '../orders/orders.module.js';
import { CouriersController } from './couriers.controller.js';
import { COURIER_HTTP, CouriersService } from './couriers.service.js';
import { CredentialVault } from './credential-vault.js';
import { ShipmentsService } from './shipments.service.js';
import { WebhooksController } from './webhooks.controller.js';
import { WebhooksService } from './webhooks.service.js';

@Module({
  imports: [AuditModule, OrdersModule],
  controllers: [CouriersController, WebhooksController],
  // COURIER_HTTP is empty in production (real network, real timers); tests replace it with a fake network.
  providers: [
    { provide: COURIER_HTTP, useValue: {} },
    CredentialVault,
    CouriersService,
    ShipmentsService,
    WebhooksService,
  ],
})
export class CouriersModule {}
