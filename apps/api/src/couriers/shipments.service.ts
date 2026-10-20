import { createHash, randomUUID } from 'node:crypto';
import { Injectable, Logger } from '@nestjs/common';
import type {
  BookShipmentBody,
  CourierProvider,
  ResolveShipmentBody,
  ShipmentDetail,
  SimulatedEvent,
  Shipment as ShipmentDto,
  ShipmentEvent as ShipmentEventDto,
  ShipmentStatus,
} from '@orderloop/contracts';
import {
  advanceShipment,
  CourierError,
  type BookingResult,
  type CourierAdapter,
  type TrackingResult,
} from '@orderloop/courier-sdk';
import { Database, isUniqueViolation, type Prisma, type Tx } from '@orderloop/db';
import { can, type OrderStatus } from '@orderloop/domain';
import { AuditService } from '../audit/audit.service.js';
import { ApiError } from '../common/api-error.js';
import { stable } from '../common/stable.js';
import type { AuthContext } from '../common/endpoint.js';
import { liveShipmentOf } from '../orders/live-shipment.js';
import { OrdersService } from '../orders/orders.service.js';
import { CouriersService, courierProblem } from './couriers.service.js';
import { planOrderMoves } from './order-sync.js';
import { capabilitiesOf, PROVIDERS } from './providers.js';

type ShipmentRow = NonNullable<Awaited<ReturnType<Tx['shipment']['findFirst']>>>;
type EventRow = NonNullable<Awaited<ReturnType<Tx['shipmentEvent']['findFirst']>>>;

/** A booking claimed but never settled for this long is treated as unconfirmed (the process died mid-booking). */
const STALE_BOOKING_MS = 120_000;
/** A cancel keeps its transaction open while the courier answers, so it may outlast the default 5 seconds. */
const CANCEL_TX_MS = 30_000;
/** Statuses that never change again, or that leave room for a fresh booking. */
const ENDED: ShipmentStatus[] = ['booking_failed', 'cancelled', 'returned'];

export interface IncomingEvent {
  source: 'webhook' | 'poll' | 'manual' | 'simulation';
  eventKey: string;
  providerStatus: string;
  /** Null for an update that carries a message but no status. */
  status: ShipmentStatus | null;
  occurredAt?: string | undefined;
  note?: string | undefined;
  payload?: unknown;
  deliveryFeeMinor?: number | undefined;
}

export type EventOutcome = 'applied' | 'recorded' | 'duplicate';

@Injectable()
export class ShipmentsService {
  private readonly log = new Logger('Shipments');

  constructor(
    private readonly db: Database,
    private readonly audit: AuditService,
    private readonly couriers: CouriersService,
    private readonly orders: OrdersService,
  ) {}

  // ---- presenting ----------------------------------------------------------------------------------------------------

  /** A booking claimed but never settled (the server died mid-call) counts as unconfirmed after a while. */
  stale(row: ShipmentRow): boolean {
    return row.status === 'booking' && Date.now() - row.updatedAt.getTime() > STALE_BOOKING_MS;
  }

  private toShipment(row: ShipmentRow, orderNumber: number): ShipmentDto {
    const caps = capabilitiesOf(row.provider);
    const status = row.status as ShipmentStatus;
    const needsResolution = status === 'booking_uncertain' || this.stale(row);
    return {
      id: row.id,
      orderId: row.orderId,
      orderNumber,
      provider: row.provider,
      environment: row.environment,
      simulated: row.simulated,
      status,
      providerStatus: row.providerStatus,
      consignmentId: row.providerConsignmentId,
      reference: row.providerReference,
      trackingCode: row.trackingCode,
      trackingUrl: row.trackingUrl,
      attempt: row.attempt,
      codAmountMinor: row.codAmountMinor,
      deliveryFeeMinor: row.deliveryFeeMinor,
      failureReason: row.failureReason,
      bookedAt: row.bookedAt?.toISOString() ?? null,
      lastEventAt: row.lastEventAt?.toISOString() ?? null,
      lastSyncedAt: row.lastSyncedAt?.toISOString() ?? null,
      createdAt: row.createdAt.toISOString(),
      actions: {
        canRefresh:
          !ENDED.includes(status) &&
          !(status === 'booking' && !needsResolution) &&
          (!needsResolution || caps.duplicateProtection === 'reference'),
        canCancel: status === 'booked' && caps.cancel,
        needsResolution,
        canSimulate:
          row.simulated &&
          !ENDED.includes(status) &&
          !['booking', 'booking_uncertain'].includes(status),
        canMarkCancelled: status === 'booked' && !caps.cancel,
      },
    };
  }

  private toEvent(e: EventRow): ShipmentEventDto {
    return {
      id: e.id,
      source: e.source,
      providerStatus: e.providerStatus,
      mappedStatus: e.mappedStatus,
      applied: e.applied,
      note: e.note,
      occurredAt: e.occurredAt?.toISOString() ?? null,
      createdAt: e.createdAt.toISOString(),
    };
  }

  private async detail(tx: Tx, tenantId: string, id: string): Promise<ShipmentDetail> {
    const row = await tx.shipment.findFirst({
      where: { id, tenantId },
      include: {
        order: { select: { orderNumber: true } },
        events: { orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] },
      },
    });
    if (!row) throw ApiError.notFound('Shipment not found');
    return {
      ...this.toShipment(row, row.order.orderNumber),
      events: row.events.map((e) => this.toEvent(e)),
    };
  }

  async get(auth: AuthContext, id: string): Promise<ShipmentDetail> {
    return this.db.withContext({ tenantId: auth.tenantId }, (tx) =>
      this.detail(tx, auth.tenantId, id),
    );
  }

  async listForOrder(auth: AuthContext, orderId: string): Promise<ShipmentDto[]> {
    return this.db.withContext({ tenantId: auth.tenantId }, async (tx) => {
      const order = await tx.order.findFirst({
        where: { id: orderId, tenantId: auth.tenantId },
        select: { orderNumber: true },
      });
      if (!order) throw ApiError.notFound('Order not found');
      const rows = await tx.shipment.findMany({
        where: { tenantId: auth.tenantId, orderId },
        orderBy: [{ attempt: 'desc' }],
      });
      return rows.map((r) => this.toShipment(r, order.orderNumber));
    });
  }

  private async lock(tx: Tx, tenantId: string, id: string): Promise<ShipmentRow> {
    const locked = await tx.$queryRaw<{ id: string }[]>`
      SELECT id FROM shipments WHERE tenant_id = ${tenantId}::uuid AND id = ${id}::uuid FOR UPDATE`;
    if (!locked[0]) throw ApiError.notFound('Shipment not found');
    return tx.shipment.findFirstOrThrow({ where: { id, tenantId } });
  }

  private async load(auth: { tenantId: string }, id: string): Promise<ShipmentRow> {
    const row = await this.db.withContext({ tenantId: auth.tenantId }, (tx) =>
      tx.shipment.findFirst({ where: { id, tenantId: auth.tenantId } }),
    );
    if (!row) throw ApiError.notFound('Shipment not found');
    return row;
  }

  private async adapterOf(tenantId: string, row: ShipmentRow): Promise<CourierAdapter> {
    const connection = await this.db.withContext({ tenantId }, (tx) =>
      tx.courierConnection.findFirstOrThrow({ where: { id: row.connectionId, tenantId } }),
    );
    if (connection.provider !== 'mock' && !connection.credentialsEnc)
      throw new ApiError(
        409,
        'courier_not_configured',
        `${PROVIDERS[row.provider].name} has no saved credentials.`,
      );
    return this.couriers.adapterFor(connection);
  }

  // ---- booking -------------------------------------------------------------------------------------------------------

  /** Refuse a weight the courier would refuse, before a shipment exists (the contract allows more than any one courier does). */
  private assertWeight(provider: CourierProvider, weightKg: number | undefined): void {
    const { min, max } = capabilitiesOf(provider).weightKg;
    if (weightKg !== undefined && (weightKg < min || weightKg > max))
      throw new ApiError(
        400,
        'validation_failed',
        `${PROVIDERS[provider].name} takes parcels of ${min} to ${max} kg.`,
        [
          {
            path: 'body.weightKg',
            message: `Must be between ${min} and ${max} kg for ${PROVIDERS[provider].name}`,
          },
        ],
      );
  }

  async book(
    auth: AuthContext,
    orderId: string,
    body: BookShipmentBody,
    ip: string | null,
  ): Promise<ShipmentDetail> {
    const requestHash = createHash('sha256')
      .update(
        stable({
          orderId,
          provider: body.provider,
          weightKg: body.weightKg,
          note: body.note,
          cityId: body.cityId,
          zoneId: body.zoneId,
          areaId: body.areaId,
        }),
      )
      .digest('hex');
    const ctx = { tenantId: auth.tenantId, userId: auth.userId };

    // 1. Claim the order. Everything that could create a duplicate is decided here, under the order's row lock, before the courier is contacted.
    const claimed = await this.db.withContext(ctx, async (tx) => {
      const connection = await this.couriers.usableConnection(tx, auth.tenantId, body.provider);
      const locked = await tx.$queryRaw<{ id: string }[]>`
        SELECT id FROM orders WHERE tenant_id = ${auth.tenantId}::uuid AND id = ${orderId}::uuid FOR UPDATE`;
      if (!locked[0]) throw ApiError.notFound('Order not found');
      const order = await tx.order.findFirstOrThrow({
        where: { id: orderId, tenantId: auth.tenantId },
        include: { items: { orderBy: { position: 'asc' } } },
      });

      const replay = await tx.shipment.findFirst({
        where: { tenantId: auth.tenantId, idempotencyKey: body.idempotencyKey },
      });
      if (replay) {
        if (replay.requestHash !== requestHash || replay.orderId !== orderId)
          throw new ApiError(
            409,
            'idempotency_conflict',
            'This idempotency key was already used for a different booking.',
          );
        return { replay: replay.id, order, connection, shipmentId: replay.id };
      }
      const live = await liveShipmentOf(tx, auth.tenantId, orderId);
      if (live)
        throw new ApiError(
          409,
          'shipment_conflict',
          live.status === 'booking' || live.status === 'booking_uncertain'
            ? 'An earlier booking for this order is not confirmed yet. Settle it before booking again.'
            : 'This order already has a shipment. Cancel it first to book another.',
        );
      if (order.status !== 'ready_to_ship')
        throw new ApiError(
          409,
          'shipment_conflict',
          'Mark the order Ready to ship before booking a courier.',
        );

      this.assertWeight(
        body.provider,
        body.weightKg ??
          (connection.settings as { defaultWeightKg?: number } | null)?.defaultWeightKg,
      );

      const attempt =
        ((
          await tx.shipment.aggregate({
            where: { tenantId: auth.tenantId, orderId },
            _max: { attempt: true },
          })
        )._max.attempt ?? 0) + 1;
      const reference =
        attempt === 1 ? `OL-${order.orderNumber}` : `OL-${order.orderNumber}-${attempt}`;
      let created: ShipmentRow;
      try {
        created = await tx.shipment.create({
          data: {
            tenantId: auth.tenantId,
            orderId,
            connectionId: connection.id,
            provider: body.provider,
            environment: connection.environment,
            simulated: body.provider === 'mock',
            status: 'booking',
            providerReference: reference,
            attempt,
            codAmountMinor: order.codAmountMinor,
            idempotencyKey: body.idempotencyKey,
            requestHash,
            createdById: auth.userId,
          },
        });
      } catch (error) {
        // A parallel request got in between our checks (the unique indexes are the last word).
        if (isUniqueViolation(error))
          throw new ApiError(409, 'shipment_conflict', 'This order is being booked right now.');
        throw error;
      }
      await tx.shipmentEvent.create({
        data: {
          tenantId: auth.tenantId,
          shipmentId: created.id,
          source: 'booking',
          eventKey: 'booking:start',
          applied: true,
          note: `Booking started with ${PROVIDERS[body.provider].name}${created.simulated ? ' (simulated)' : ''}`,
        },
      });
      await this.audit.record(tx, {
        tenantId: auth.tenantId,
        actorUserId: auth.userId,
        action: 'shipment.booking_started',
        targetType: 'shipment',
        targetId: created.id,
        metadata: {
          orderNumber: order.orderNumber,
          provider: body.provider,
          simulated: created.simulated,
          reference,
        },
        ip,
      });
      return { replay: null, order, connection, shipmentId: created.id };
    });

    if (claimed.replay) return this.get(auth, claimed.replay);

    // 2. Ask the courier. Nothing is held open in the database while we wait.
    const { order, connection, shipmentId } = claimed;
    const settings = (connection.settings ?? {}) as { defaultWeightKg?: number };
    const shipment = await this.load(auth, shipmentId);
    let adapter: CourierAdapter | null = null;
    let result: BookingResult | null = null;
    let failure: unknown = null;
    try {
      // Inside the try: unreadable credentials must settle this booking, not leave it claimed forever.
      adapter = this.couriers.adapterFor(connection);
      result = await adapter.book({
        reference: shipment.providerReference,
        recipient: {
          name: order.shipName,
          phone: order.shipPhone,
          address: [order.shipLine1, order.shipArea, order.shipDistrict, order.shipDivision].join(
            ', ',
          ),
        },
        codAmountMinor: order.codAmountMinor,
        itemDescription: order.items
          .map((i) => `${i.productName}${i.variantName ? ` ${i.variantName}` : ''} x${i.quantity}`)
          .join(', ')
          .slice(0, 250),
        itemQuantity: order.items.reduce((n, i) => n + i.quantity, 0),
        weightKg: body.weightKg ?? settings.defaultWeightKg,
        note: body.note,
        options: { cityId: body.cityId, zoneId: body.zoneId, areaId: body.areaId },
      });
    } catch (error) {
      failure = error;
    }

    // 3. Settle what happened.
    if (result) return this.settleBooked(auth, shipmentId, result, ip);
    return this.settleFailure(auth, shipmentId, adapter, failure, ip);
  }

  private async settleBooked(
    auth: AuthContext,
    id: string,
    result: BookingResult,
    ip: string | null,
  ): Promise<ShipmentDetail> {
    return this.db.withContext({ tenantId: auth.tenantId, userId: auth.userId }, async (tx) => {
      const row = await this.lock(tx, auth.tenantId, id);
      if (row.status === 'booking' || row.status === 'booking_uncertain') {
        await tx.shipment.update({
          where: { id },
          data: {
            status: result.status === 'unknown' ? 'booked' : result.status,
            providerStatus: result.providerStatus,
            providerConsignmentId: result.consignmentId,
            trackingCode: result.trackingCode ?? null,
            trackingUrl: result.trackingUrl ?? null,
            deliveryFeeMinor: result.deliveryFeeMinor ?? null,
            failureReason: null,
            bookedAt: new Date(),
            lastEventAt: new Date(),
          },
        });
        await tx.shipmentEvent.create({
          data: {
            tenantId: auth.tenantId,
            shipmentId: id,
            source: 'booking',
            eventKey: 'booking:result',
            providerStatus: result.providerStatus,
            mappedStatus: result.status,
            applied: true,
            note: row.simulated
              ? 'Booked with the simulated courier. No real parcel exists.'
              : 'Booked with the courier',
            payload: result.raw as Prisma.InputJsonValue,
          },
        });
        await this.audit.record(tx, {
          tenantId: auth.tenantId,
          actorUserId: auth.userId,
          action: 'shipment.booked',
          targetType: 'shipment',
          targetId: id,
          metadata: {
            provider: row.provider,
            simulated: row.simulated,
            consignmentId: result.consignmentId,
          },
          ip,
        });
      }
      return this.detail(tx, auth.tenantId, id);
    });
  }

  private friendly(error: unknown): string {
    if (error instanceof ApiError) return error.detail ?? 'The courier connection cannot be used.';
    if (error instanceof CourierError) {
      if (error.kind === 'auth' || error.kind === 'forbidden')
        return 'The courier did not accept the saved credentials.';
      if (error.kind === 'unavailable')
        return 'The courier could not be reached or did not answer in time.';
      return error.message;
    }
    return 'The booking failed unexpectedly.';
  }

  private async settleFailure(
    auth: AuthContext,
    id: string,
    adapter: CourierAdapter | null,
    error: unknown,
    ip: string | null,
  ): Promise<ShipmentDetail> {
    const known = error instanceof CourierError ? error : null;
    if (!known && adapter)
      this.log.error(
        `Unexpected failure booking shipment ${id}: ${(error as Error)?.message ?? error}`,
      );
    // Only a courier that said "no" (or never got the request, or we had no adapter to send it with) leaves nothing
    // behind. Anything else may have created a parcel.
    let outcome: 'failed' | 'uncertain' =
      !adapter || (known && !known.outcomeUnknown) ? 'failed' : 'uncertain';
    let found: TrackingResult | null = null;
    let reason = this.friendly(error);
    const row = await this.load(auth, id);

    if (
      outcome === 'uncertain' &&
      adapter?.findByReference &&
      adapter.capabilities.duplicateProtection === 'reference'
    ) {
      try {
        found = await adapter.findByReference(row.providerReference);
        if (!found) {
          // The courier knows our reference and has no such booking. It refuses a repeated reference, so trying again cannot duplicate it.
          outcome = 'failed';
          reason = `${reason} The courier has no booking with this reference, so nothing was created.`;
        }
      } catch {
        // Could not ask either: stay uncertain.
      }
    }

    return this.db.withContext({ tenantId: auth.tenantId, userId: auth.userId }, async (tx) => {
      const locked = await this.lock(tx, auth.tenantId, id);
      if (locked.status !== 'booking') return this.detail(tx, auth.tenantId, id);
      if (found) {
        await tx.shipment.update({
          where: { id },
          data: {
            status: found.status === 'unknown' ? 'booked' : found.status,
            providerStatus: found.providerStatus,
            providerConsignmentId: found.consignmentId,
            failureReason: null,
            bookedAt: new Date(),
            lastEventAt: new Date(),
          },
        });
        await tx.shipmentEvent.create({
          data: {
            tenantId: auth.tenantId,
            shipmentId: id,
            source: 'booking',
            eventKey: 'booking:result',
            providerStatus: found.providerStatus,
            mappedStatus: found.status,
            applied: true,
            note: 'The reply was lost, but the courier confirmed it has this booking (found by our reference).',
            payload: found.raw as Prisma.InputJsonValue,
          },
        });
        await this.audit.record(tx, {
          tenantId: auth.tenantId,
          actorUserId: auth.userId,
          action: 'shipment.booked',
          targetType: 'shipment',
          targetId: id,
          metadata: { provider: locked.provider, recovered: true },
          ip,
        });
        return this.detail(tx, auth.tenantId, id);
      }
      const status = outcome === 'failed' ? 'booking_failed' : 'booking_uncertain';
      const message =
        outcome === 'failed'
          ? reason
          : `${reason} We cannot tell whether ${PROVIDERS[locked.provider].name} received the booking. Look for reference ${locked.providerReference} in the courier's own panel, then say what you found. Booking again before that could send two parcels.`;
      await tx.shipment.update({ where: { id }, data: { status, failureReason: message } });
      await tx.shipmentEvent.create({
        data: {
          tenantId: auth.tenantId,
          shipmentId: id,
          source: 'booking',
          eventKey: 'booking:result',
          applied: true,
          mappedStatus: status,
          note: message,
        },
      });
      await this.audit.record(tx, {
        tenantId: auth.tenantId,
        actorUserId: auth.userId,
        action: outcome === 'failed' ? 'shipment.booking_failed' : 'shipment.booking_uncertain',
        targetType: 'shipment',
        targetId: id,
        metadata: { provider: locked.provider },
        ip,
      });
      return this.detail(tx, auth.tenantId, id);
    });
  }

  // ---- courier news --------------------------------------------------------------------------------------------------

  /**
   * Take one piece of courier news (webhook, poll, simulation) into a locked shipment: record it, move the shipment if the
   * rules allow, and carry the order forward. Recording and acting are in one transaction, and an identical event
   * (same key) is recognised and ignored, so a retried webhook changes nothing.
   */
  async applyEvent(
    tx: Tx,
    tenantId: string,
    shipment: ShipmentRow,
    event: IncomingEvent,
    ip: string | null,
  ): Promise<EventOutcome> {
    if (['booking', 'booking_uncertain', 'booking_failed'].includes(shipment.status))
      throw new Error('An event reached a shipment whose booking is not settled');
    const seen = await tx.shipmentEvent.findFirst({
      where: { tenantId, shipmentId: shipment.id, eventKey: event.eventKey },
      select: { id: true },
    });
    if (seen) return 'duplicate';

    const from = shipment.status as ShipmentStatus;
    const advance = advanceShipment(from as never, event.status as never);
    let note = event.note ?? null;
    let orderNote: string | null = null;

    if (advance.apply && event.status) {
      await tx.shipment.update({
        where: { id: shipment.id },
        data: {
          status: event.status,
          providerStatus: event.providerStatus,
          lastEventAt: new Date(),
          ...(event.deliveryFeeMinor !== undefined
            ? { deliveryFeeMinor: event.deliveryFeeMinor }
            : {}),
        },
      });
      orderNote = await this.syncOrder(tx, tenantId, shipment, event, ip);
    } else if (!advance.apply) {
      const why = {
        duplicate: 'The courier repeated a status we already had.',
        not_a_status: 'A note from the courier, with no status change.',
        out_of_order: `Ignored: ${from.replace(/_/g, ' ')} cannot become ${event.status?.replace(/_/g, ' ')}. It arrived late or out of order.`,
        unknown_status:
          'The courier used a status we do not recognise. Shown as sent; nothing was changed.',
      }[advance.reason];
      note = note ? `${note} ${why}` : why;
      if (advance.reason === 'unknown_status')
        await tx.shipment.update({
          where: { id: shipment.id },
          data: { providerStatus: event.providerStatus, lastEventAt: new Date() },
        });
    }
    if (orderNote) note = note ? `${note} ${orderNote}` : orderNote;

    await tx.shipmentEvent.create({
      data: {
        tenantId,
        shipmentId: shipment.id,
        source: event.source,
        eventKey: event.eventKey,
        providerStatus: event.providerStatus,
        mappedStatus: event.status,
        applied: advance.apply,
        note,
        payload: (event.payload ?? undefined) as Prisma.InputJsonValue | undefined,
        occurredAt:
          event.occurredAt && !Number.isNaN(Date.parse(event.occurredAt))
            ? new Date(event.occurredAt)
            : null,
      },
    });
    return advance.apply ? 'applied' : 'recorded';
  }

  /** Carry the order forward by the moves its own rules allow. Returns a note when the order is deliberately left alone. */
  private async syncOrder(
    tx: Tx,
    tenantId: string,
    shipment: ShipmentRow,
    event: IncomingEvent,
    ip: string | null,
  ): Promise<string | null> {
    if (!event.status) return null;
    const order = await tx.order.findFirst({
      where: { id: shipment.orderId, tenantId },
      select: { status: true },
    });
    if (!order) return null;
    const plan = planOrderMoves(order.status as OrderStatus, event.status);
    if (!plan.steps.length) return plan.note;
    const label = shipment.simulated ? 'Simulated courier update' : 'Courier update';
    // All the steps are one unit: if any is refused, the ones before it (stock moves, history) are undone with it, so the
    // order is either carried forward as planned or left exactly as it was.
    await tx.$executeRaw`SAVEPOINT order_sync`;
    for (const step of plan.steps) {
      try {
        await this.orders.moveInTx(
          tx,
          { tenantId, userId: null },
          shipment.orderId,
          { status: step, reason: `${label}: ${event.providerStatus}` },
          ip,
        );
      } catch (error) {
        if (!(error instanceof ApiError)) throw error;
        await tx.$executeRaw`ROLLBACK TO SAVEPOINT order_sync`;
        return `The order was not changed: ${error.detail ?? error.message}`;
      }
    }
    await tx.$executeRaw`RELEASE SAVEPOINT order_sync`;
    return plan.note;
  }

  // ---- refreshing ----------------------------------------------------------------------------------------------------

  async refresh(auth: AuthContext, id: string, ip: string | null): Promise<ShipmentDetail> {
    const row = await this.load(auth, id);
    const view = this.toShipment(row, 0);
    if (ENDED.includes(row.status as ShipmentStatus))
      throw new ApiError(
        409,
        'shipment_conflict',
        'This shipment has ended; there is nothing to refresh.',
      );
    const adapter = await this.adapterOf(auth.tenantId, row);

    if (view.actions.needsResolution || row.status === 'booking') {
      if (!view.actions.needsResolution)
        throw new ApiError(
          409,
          'shipment_conflict',
          'The booking is still being made. Check again in a moment.',
        );
      if (!adapter.findByReference || adapter.capabilities.duplicateProtection !== 'reference')
        throw new ApiError(
          422,
          'courier_unsupported',
          `${PROVIDERS[row.provider].name} cannot be asked about a booking by reference. Look in its panel and use “Settle this booking”.`,
        );
      let found: TrackingResult | null;
      try {
        found = await adapter.findByReference(row.providerReference);
      } catch (error) {
        if (error instanceof CourierError) throw courierProblem(error);
        throw error;
      }
      return this.db.withContext({ tenantId: auth.tenantId, userId: auth.userId }, async (tx) => {
        const locked = await this.lock(tx, auth.tenantId, id);
        if (locked.status !== 'booking_uncertain' && locked.status !== 'booking')
          return this.detail(tx, auth.tenantId, id);
        if (found) {
          await tx.shipment.update({
            where: { id },
            data: {
              status: found.status === 'unknown' ? 'booked' : found.status,
              providerStatus: found.providerStatus,
              providerConsignmentId: found.consignmentId,
              failureReason: null,
              bookedAt: new Date(),
              lastEventAt: new Date(),
              lastSyncedAt: new Date(),
            },
          });
          await tx.shipmentEvent.create({
            data: {
              tenantId: auth.tenantId,
              shipmentId: id,
              source: 'poll',
              eventKey: 'poll:found',
              providerStatus: found.providerStatus,
              mappedStatus: found.status,
              applied: true,
              note: 'Found at the courier by our reference.',
              payload: found.raw as Prisma.InputJsonValue,
            },
          });
          await this.audit.record(tx, {
            tenantId: auth.tenantId,
            actorUserId: auth.userId,
            action: 'shipment.booked',
            targetType: 'shipment',
            targetId: id,
            metadata: { provider: row.provider, recovered: true },
            ip,
          });
        } else {
          const message =
            'The courier has no booking with this reference, so nothing was created. You can book again.';
          await tx.shipment.update({
            where: { id },
            data: { status: 'booking_failed', failureReason: message, lastSyncedAt: new Date() },
          });
          await tx.shipmentEvent.create({
            data: {
              tenantId: auth.tenantId,
              shipmentId: id,
              source: 'poll',
              eventKey: 'poll:not_found',
              applied: true,
              mappedStatus: 'booking_failed',
              note: message,
            },
          });
          await this.audit.record(tx, {
            tenantId: auth.tenantId,
            actorUserId: auth.userId,
            action: 'shipment.booking_failed',
            targetType: 'shipment',
            targetId: id,
            metadata: { provider: row.provider, lookedUp: true },
            ip,
          });
        }
        return this.detail(tx, auth.tenantId, id);
      });
    }

    let tracked: TrackingResult;
    try {
      tracked = await adapter.track({
        consignmentId: row.providerConsignmentId,
        reference: row.providerReference,
        last: row.providerStatus
          ? { providerStatus: row.providerStatus, status: row.status as never }
          : undefined,
      });
    } catch (error) {
      if (error instanceof CourierError) throw courierProblem(error);
      throw error;
    }
    return this.db.withContext({ tenantId: auth.tenantId, userId: auth.userId }, async (tx) => {
      const locked = await this.lock(tx, auth.tenantId, id);
      await tx.shipment.update({
        where: { id },
        data: {
          lastSyncedAt: new Date(),
          ...(tracked.consignmentId && !locked.providerConsignmentId
            ? { providerConsignmentId: tracked.consignmentId }
            : {}),
        },
      });
      // An unchanged status is not news: it makes no event. Anything else is recorded, applied or not.
      if (tracked.status !== locked.status || tracked.status === 'unknown')
        await this.applyEvent(
          tx,
          auth.tenantId,
          locked,
          {
            source: 'poll',
            eventKey: `poll:${tracked.providerStatus}:${tracked.updatedAt ?? ''}`,
            providerStatus: tracked.providerStatus,
            status: tracked.status,
            occurredAt: tracked.updatedAt,
            deliveryFeeMinor: tracked.deliveryFeeMinor,
            payload: tracked.raw,
          },
          ip,
        );
      return this.detail(tx, auth.tenantId, id);
    });
  }

  // ---- cancelling, settling, simulating --------------------------------------------------------------------------------

  /**
   * Cancel a booked parcel through the courier's API. The shipment row stays locked from the check to the update, so two
   * people cancelling, or a webhook arriving meanwhile, take turns instead of interleaving (a webhook waits for the courier's
   * answer; the courier call has its own timeout). The courier is only asked once the row is ours and still booked.
   */
  async cancel(
    auth: AuthContext,
    id: string,
    reason: string,
    ip: string | null,
  ): Promise<ShipmentDetail> {
    const notCancellable = () =>
      new ApiError(
        409,
        'shipment_conflict',
        'Only a booked parcel that has not been picked up can be cancelled.',
      );
    const row = await this.load(auth, id);
    if (row.status !== 'booked') throw notCancellable();
    const adapter = await this.adapterOf(auth.tenantId, row);
    if (!adapter.cancel)
      throw new ApiError(
        409,
        'courier_unsupported',
        `${PROVIDERS[row.provider].name} has no documented way to cancel a booking through its API. Cancel it in the courier's own panel or by phone, then choose “Mark cancelled at the courier”.`,
      );
    return this.db.withContext(
      { tenantId: auth.tenantId, userId: auth.userId },
      async (tx) => {
        const locked = await this.lock(tx, auth.tenantId, id);
        if (locked.status !== 'booked') throw notCancellable();
        let outcome: { cancelled: boolean; message?: string | undefined };
        try {
          outcome = await adapter.cancel!({
            consignmentId: locked.providerConsignmentId,
            reference: locked.providerReference,
            last: locked.providerStatus
              ? { providerStatus: locked.providerStatus, status: locked.status as never }
              : undefined,
          });
        } catch (error) {
          if (error instanceof CourierError) throw courierProblem(error);
          throw error;
        }
        if (!outcome.cancelled)
          throw new ApiError(
            409,
            'courier_rejected',
            outcome.message ?? 'The courier would not cancel this parcel.',
          );
        await tx.shipment.update({
          where: { id },
          data: { status: 'cancelled', lastEventAt: new Date() },
        });
        await tx.shipmentEvent.create({
          data: {
            tenantId: auth.tenantId,
            shipmentId: id,
            source: 'manual',
            eventKey: `cancel:${randomUUID()}`,
            mappedStatus: 'cancelled',
            applied: true,
            note: `Cancelled with the courier: ${reason}`,
          },
        });
        await this.audit.record(tx, {
          tenantId: auth.tenantId,
          actorUserId: auth.userId,
          action: 'shipment.cancelled',
          targetType: 'shipment',
          targetId: id,
          metadata: { provider: row.provider, simulated: row.simulated },
          ip,
        });
        return this.detail(tx, auth.tenantId, id);
      },
      { timeout: CANCEL_TX_MS },
    );
  }

  async resolve(
    auth: AuthContext,
    id: string,
    body: ResolveShipmentBody,
    ip: string | null,
  ): Promise<ShipmentDetail> {
    // "Not booked" and "cancelled" free the order for another booking: if the person is wrong, the courier collects two
    // parcels. That is a decision for whoever manages the courier. "Booked" only ever blocks a second booking.
    if (body.resolution !== 'booked' && !can(auth.role, 'couriers:manage'))
      throw ApiError.forbidden(
        'Only an owner or admin can settle a booking as not booked or cancelled, because the order could then be booked twice.',
      );
    return this.db.withContext({ tenantId: auth.tenantId, userId: auth.userId }, async (tx) => {
      const row = await this.lock(tx, auth.tenantId, id);
      const unconfirmed = row.status === 'booking_uncertain' || this.stale(row);
      if (!unconfirmed && !(row.status === 'booked' && body.resolution === 'cancelled_at_courier'))
        throw new ApiError(
          409,
          'shipment_conflict',
          'There is nothing to settle on this shipment.',
        );
      if (
        body.resolution === 'cancelled_at_courier' &&
        row.status === 'booked' &&
        capabilitiesOf(row.provider).cancel
      )
        throw new ApiError(
          409,
          'shipment_conflict',
          'This courier can cancel through its API: use Cancel.',
        );
      const to: ShipmentStatus = {
        not_booked: 'booking_failed',
        booked: 'booked',
        cancelled_at_courier: 'cancelled',
      }[body.resolution] as ShipmentStatus;
      await tx.shipment.update({
        where: { id },
        data: {
          status: to,
          lastEventAt: new Date(),
          failureReason: to === 'booking_failed' ? `Settled by a person: ${body.reason}` : null,
          ...(to === 'booked'
            ? {
                bookedAt: row.bookedAt ?? new Date(),
                ...(body.consignmentId ? { providerConsignmentId: body.consignmentId } : {}),
              }
            : {}),
        },
      });
      const label = {
        not_booked: 'Not booked at the courier',
        booked: 'Booked at the courier',
        cancelled_at_courier: 'Cancelled at the courier',
      }[body.resolution];
      await tx.shipmentEvent.create({
        data: {
          tenantId: auth.tenantId,
          shipmentId: id,
          source: 'manual',
          eventKey: `resolve:${randomUUID()}`,
          mappedStatus: to,
          applied: true,
          note: `${label} (settled by a person): ${body.reason}`,
        },
      });
      await this.audit.record(tx, {
        tenantId: auth.tenantId,
        actorUserId: auth.userId,
        action: 'shipment.resolved',
        targetType: 'shipment',
        targetId: id,
        metadata: { provider: row.provider, resolution: body.resolution, from: row.status },
        ip,
      });
      return this.detail(tx, auth.tenantId, id);
    });
  }

  async simulate(
    auth: AuthContext,
    id: string,
    event: SimulatedEvent,
    ip: string | null,
  ): Promise<ShipmentDetail> {
    return this.db.withContext({ tenantId: auth.tenantId, userId: auth.userId }, async (tx) => {
      const row = await this.lock(tx, auth.tenantId, id);
      if (!row.simulated || row.provider !== 'mock')
        throw new ApiError(
          409,
          'shipment_conflict',
          'Only simulated shipments can be moved by hand. A real courier reports its own progress.',
        );
      if (['booking', 'booking_uncertain', 'booking_failed', 'cancelled'].includes(row.status))
        throw new ApiError(409, 'shipment_conflict', 'This simulated shipment is not booked.');
      await this.applyEvent(
        tx,
        auth.tenantId,
        row,
        {
          source: 'simulation',
          eventKey: `sim:${randomUUID()}`,
          providerStatus: `simulated:${event}`,
          status: event,
          note: 'Simulated update. No courier sent this.',
        },
        ip,
      );
      await this.audit.record(tx, {
        tenantId: auth.tenantId,
        actorUserId: auth.userId,
        action: 'shipment.simulated_event',
        targetType: 'shipment',
        targetId: id,
        metadata: { event },
        ip,
      });
      return this.detail(tx, auth.tenantId, id);
    });
  }

  // ---- used by the webhook handler -------------------------------------------------------------------------------------

  /** Find the shipment a courier is talking about, by the courier's id or by our reference. */
  async findForWebhook(
    tx: Tx,
    tenantId: string,
    provider: CourierProvider,
    ids: { consignmentId: string | null; reference: string | null },
  ): Promise<ShipmentRow | null> {
    const or: Prisma.ShipmentWhereInput[] = [];
    if (ids.consignmentId) or.push({ providerConsignmentId: ids.consignmentId });
    if (ids.reference) or.push({ providerReference: ids.reference });
    if (!or.length) return null;
    const row = await tx.shipment.findFirst({
      where: { tenantId, provider, OR: or },
      orderBy: { attempt: 'desc' },
    });
    if (!row) return null;
    return this.lock(tx, tenantId, row.id);
  }
}
