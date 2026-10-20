import { Injectable } from '@nestjs/common';
import type {
  Reservation,
  ReservationBody,
  ReservationPage,
  ReservationQuery,
} from '@orderloop/contracts';
import {
  reserveStock,
  resolveLocation,
  resolveReservation,
  type ReservationOutcome,
} from '@orderloop/catalog';
import { Database } from '@orderloop/db';
import { ApiError } from '../common/api-error.js';
import { decodeCursor, encodeCursor } from '../common/cursor.js';
import type { AuthContext } from '../common/endpoint.js';
import { mapStockError } from '../common/stock-errors.js';
import { StockRunner } from './inventory.service.js';

type Row = {
  id: string;
  variantId: string;
  locationId: string;
  quantity: number;
  status: 'ACTIVE' | 'RELEASED' | 'FULFILLED';
  referenceType: string | null;
  referenceId: string | null;
  createdAt: Date;
  resolvedAt: Date | null;
};

const toReservation = (r: Row): Reservation => ({
  id: r.id,
  variantId: r.variantId,
  locationId: r.locationId,
  quantity: r.quantity,
  status: r.status,
  referenceType: r.referenceType,
  referenceId: r.referenceId,
  createdAt: r.createdAt.toISOString(),
  resolvedAt: r.resolvedAt?.toISOString() ?? null,
});

/** Reservations made for an order belong to that order: only the order's own transitions may move them. */
const ORDER_REFERENCE = 'order';

@Injectable()
export class ReservationsService {
  constructor(
    private readonly db: Database,
    private readonly runner: StockRunner,
  ) {}

  async create(auth: AuthContext, body: ReservationBody): Promise<Reservation> {
    if (body.referenceType === ORDER_REFERENCE) {
      throw new ApiError(400, 'validation_failed', 'Request validation failed', [
        {
          path: 'referenceType',
          message: 'Reservations for orders are created by the order itself',
        },
      ]);
    }
    return this.runner.run(
      auth,
      body.idempotencyKey,
      {
        variantId: body.variantId,
        locationId: body.locationId,
        type: 'RESERVE',
        reservedDelta: body.quantity,
      },
      async (tx) => {
        await this.runner.requireActiveVariant(tx, auth.tenantId, body.variantId);
        const locationId = await resolveLocation(tx, auth.tenantId, body.locationId);
        const r = await reserveStock(
          tx,
          { tenantId: auth.tenantId, variantId: body.variantId, locationId },
          body.quantity,
          {
            createdById: auth.userId,
            referenceType: body.referenceType,
            referenceId: body.referenceId,
            idempotencyKey: body.idempotencyKey,
          },
        );
        return toReservation(
          await tx.reservation.findUniqueOrThrow({ where: { id: r.reservationId } }),
        );
      },
      async (tx, prior) =>
        toReservation(
          await tx.reservation.findUniqueOrThrow({ where: { id: prior.reservationId! } }),
        ),
    );
  }

  private async resolve(
    auth: AuthContext,
    id: string,
    outcome: ReservationOutcome,
  ): Promise<Reservation> {
    try {
      return await this.db.withContext(
        { tenantId: auth.tenantId, userId: auth.userId },
        async (tx) => {
          const owner = await tx.reservation.findFirst({
            where: { id, tenantId: auth.tenantId },
            select: { referenceType: true },
          });
          if (owner?.referenceType === ORDER_REFERENCE) {
            throw ApiError.conflict(
              'This reservation belongs to an order. Change the order instead of releasing or fulfilling it here.',
            );
          }
          const done = await resolveReservation(tx, auth.tenantId, id, outcome, {
            createdById: auth.userId,
          });
          if (!done) {
            const existing = await tx.reservation.findFirst({
              where: { id, tenantId: auth.tenantId },
              select: { status: true },
            });
            if (!existing) throw ApiError.notFound('Reservation not found');
            throw ApiError.conflict(`Reservation is already ${existing.status}`);
          }
          return toReservation(await tx.reservation.findUniqueOrThrow({ where: { id } }));
        },
      );
    } catch (error) {
      return mapStockError(error);
    }
  }

  release(auth: AuthContext, id: string): Promise<Reservation> {
    return this.resolve(auth, id, 'RELEASED');
  }

  fulfil(auth: AuthContext, id: string): Promise<Reservation> {
    return this.resolve(auth, id, 'FULFILLED');
  }

  list(auth: AuthContext, query: ReservationQuery): Promise<ReservationPage> {
    const cursor = query.cursor ? decodeCursor(query.cursor) : undefined;
    return this.db.withContext({ tenantId: auth.tenantId }, async (tx) => {
      const rows = await tx.reservation.findMany({
        where: {
          tenantId: auth.tenantId,
          ...(query.status ? { status: query.status } : {}),
          ...(query.variantId ? { variantId: query.variantId } : {}),
          ...(cursor
            ? {
                OR: [
                  { createdAt: { lt: cursor.createdAt } },
                  { createdAt: cursor.createdAt, id: { lt: cursor.id } },
                ],
              }
            : {}),
        },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: query.limit + 1,
      });
      const page = rows.slice(0, query.limit);
      const last = page.at(-1);
      return {
        items: page.map(toReservation),
        nextCursor:
          rows.length > query.limit && last ? encodeCursor(last.createdAt, last.id) : null,
      };
    });
  }
}
