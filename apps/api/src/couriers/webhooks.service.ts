import { Injectable, Logger } from '@nestjs/common';
import type { CourierProvider } from '@orderloop/contracts';
import {
  parsePathaoWebhook,
  parseSteadfastWebhook,
  verifyPathaoWebhook,
  verifySteadfastWebhook,
  PATHAO_INTEGRATION_HEADER,
  PATHAO_INTEGRATION_VALUE,
  type CourierEvent,
  type ParsedWebhook,
} from '@orderloop/courier-sdk';
import { Database, type Prisma } from '@orderloop/db';
import { AuditService } from '../audit/audit.service.js';
import { CouriersService } from './couriers.service.js';
import { ShipmentsService } from './shipments.service.js';

export interface WebhookReply {
  status: number;
  body: { status: string };
  headers: Record<string, string>;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Courier webhooks. These arrive from the open internet with no user session, so the order of the steps is the defence:
 * (1) find the connection the URL names and the secret the seller saved for it; (2) check the courier's documented proof
 * (Pathao: its signature header carries the seller's webhook secret; Steadfast: a Bearer token the seller chose) in
 * constant time; only then (3) look at the body. A wrong tenant, unknown connection, missing secret and wrong secret all
 * answer the same 401, so the URL cannot be used to find out which businesses exist.
 */
@Injectable()
export class WebhooksService {
  private readonly log = new Logger('CourierWebhooks');

  constructor(
    private readonly db: Database,
    private readonly couriers: CouriersService,
    private readonly shipments: ShipmentsService,
    private readonly audit: AuditService,
  ) {}

  private reply(provider: CourierProvider, status: number, text: string): WebhookReply {
    return {
      status,
      body: { status: text },
      // Pathao requires this header on every acknowledgement; it is a public constant, not a secret.
      headers:
        provider === 'pathao' && status < 300
          ? { [PATHAO_INTEGRATION_HEADER]: PATHAO_INTEGRATION_VALUE }
          : {},
    };
  }

  async handle(
    provider: CourierProvider,
    tenantId: string,
    connectionId: string,
    headers: Record<string, string | string[] | undefined>,
    body: unknown,
  ): Promise<WebhookReply> {
    const denied = this.reply(provider, 401, 'unauthorized');
    if (provider === 'mock' || !UUID.test(tenantId) || !UUID.test(connectionId)) return denied;

    const connection = await this.db.withContext({ tenantId }, (tx) =>
      tx.courierConnection.findFirst({
        where: { id: connectionId, tenantId, provider, enabled: true },
      }),
    );
    const secret = connection ? this.couriers.webhookSecret(connection) : null;
    if (!connection || !secret) return denied;
    const authentic =
      provider === 'pathao'
        ? verifyPathaoWebhook(headers, secret)
        : verifySteadfastWebhook(headers, secret);
    if (!authentic) {
      this.log.warn(
        `Rejected a ${provider} webhook for connection ${connectionId}: bad credentials`,
      );
      return denied;
    }

    const parsed: ParsedWebhook =
      provider === 'pathao' ? parsePathaoWebhook(body) : parseSteadfastWebhook(body, headers);
    switch (parsed.kind) {
      case 'handshake':
        return this.reply(provider, 202, 'ok');
      case 'invalid':
        return this.reply(provider, 400, parsed.reason);
      case 'ignored':
        return this.reply(provider, 200, 'success');
      case 'event':
        return this.apply(provider, tenantId, parsed.event, body);
    }
  }

  private async apply(
    provider: CourierProvider,
    tenantId: string,
    event: CourierEvent,
    body: unknown,
  ): Promise<WebhookReply> {
    const outcome = await this.db.withContext({ tenantId }, async (tx) => {
      const shipment = await this.shipments.findForWebhook(tx, tenantId, provider, {
        consignmentId: event.consignmentId,
        reference: event.reference,
      });
      // News about a parcel we never booked (made in the courier's own panel): acknowledge it so the courier stops resending.
      if (!shipment) return 'unknown' as const;
      // Our own booking call has not finished. Ask the courier to send this again shortly.
      if (shipment.status === 'booking') return 'busy' as const;
      if (shipment.status === 'booking_failed') return 'unknown' as const;
      let current = shipment;
      if (shipment.status === 'booking_uncertain') {
        // The courier knows this parcel: that settles the doubt.
        current = await tx.shipment.update({
          where: { id: shipment.id },
          data: {
            status: 'booked',
            providerConsignmentId: event.consignmentId ?? shipment.providerConsignmentId,
            failureReason: null,
            bookedAt: new Date(),
          },
        });
        await tx.shipmentEvent.create({
          data: {
            tenantId,
            shipmentId: shipment.id,
            source: 'webhook',
            eventKey: `confirm:${event.eventKey}`,
            applied: true,
            mappedStatus: 'booked',
            note: 'Confirmed by the courier’s own update: this booking exists.',
          },
        });
        await this.audit.record(tx, {
          tenantId,
          actorUserId: null,
          action: 'shipment.booked',
          targetType: 'shipment',
          targetId: shipment.id,
          metadata: { provider, recovered: true, via: 'webhook' },
        });
      }
      const result = await this.shipments.applyEvent(
        tx,
        tenantId,
        current,
        {
          source: 'webhook',
          eventKey: event.eventKey,
          providerStatus: event.providerStatus,
          status: event.status,
          occurredAt: event.occurredAt,
          note: event.message,
          deliveryFeeMinor: event.deliveryFeeMinor,
          payload: body as Prisma.InputJsonValue,
        },
        null,
      );
      return result;
    });
    if (outcome === 'busy') return this.reply(provider, 503, 'busy');
    return this.reply(provider, 200, 'success');
  }
}
