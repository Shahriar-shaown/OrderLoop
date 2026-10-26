import type { DiscrepancyType } from '@orderloop/contracts';
import type { Tx } from '@orderloop/db';
import { assertPaisa, cashPosition, formatBdt, type OrderStatusName } from '@orderloop/domain';
import { AuditService } from '../audit/audit.service.js';
import { uuidv7 } from '../common/uuid.js';

const money = (minor: number) => formatBdt(assertPaisa(minor));

export interface Condition {
  expectedMinor: number | null;
  actualMinor: number | null;
  message: string;
}

export interface Subject {
  type: DiscrepancyType;
  subjectKey: string;
  itemId?: string | null;
  shipmentId?: string | null;
  orderId?: string | null;
  condition: Condition | null;
}

export interface SyncResult {
  opened: number;
  closed: number;
}

/**
 * Bring one discrepancy in line with the facts. There is at most one of each type per subject, so the same problem is never
 * recorded twice.
 *
 *  - The problem exists and none is recorded: open it. Any settlement it touches stops being "reconciled".
 *  - It is open and the problem is gone (the order was delivered, the missing cash arrived): the system closes it, saying so.
 *  - A person closed it (resolved or waived) and the figures are still what they were: it stays closed. If the figures have
 *    changed since, it opens again, because the decision was about different numbers.
 */
export async function syncDiscrepancy(
  tx: Tx,
  audit: AuditService,
  tenantId: string,
  s: Subject,
): Promise<SyncResult> {
  const existing = await tx.discrepancy.findFirst({
    where: { tenantId, subjectKey: s.subjectKey, type: s.type },
  });
  const result: SyncResult = { opened: 0, closed: 0 };
  const record = (action: string, id: string) =>
    audit.record(tx, {
      tenantId,
      actorUserId: null,
      action,
      targetType: 'discrepancy',
      targetId: id,
      metadata: { type: s.type, subject: s.subjectKey },
    });

  if (s.condition) {
    const c = s.condition;
    if (!existing) {
      // ON CONFLICT DO NOTHING: another evaluation may open the same problem at the same moment. A plain insert would
      // fail on the unique index and roll back whatever status change this evaluation belongs to; this one just yields.
      const id = uuidv7();
      const created = await tx.$queryRaw<{ id: string }[]>`
        INSERT INTO discrepancies (id, tenant_id, type, subject_key, item_id, shipment_id, order_id, expected_minor, actual_minor, message, updated_at)
        VALUES (${id}::uuid, ${tenantId}::uuid, ${s.type}::"DiscrepancyType", ${s.subjectKey}, ${s.itemId ?? null}::uuid,
                ${s.shipmentId ?? null}::uuid, ${s.orderId ?? null}::uuid, ${c.expectedMinor}::int, ${c.actualMinor}::int, ${c.message}, now())
        ON CONFLICT (tenant_id, subject_key, type) DO NOTHING
        RETURNING id`;
      if (created[0]) {
        await record('finance.discrepancy_opened', id);
        await unreconcile(tx, tenantId, s);
        result.opened++;
      }
    } else if (existing.status === 'open') {
      if (
        existing.actualMinor !== c.actualMinor ||
        existing.expectedMinor !== c.expectedMinor ||
        existing.message !== c.message
      )
        await tx.discrepancy.update({
          where: { id: existing.id },
          data: { expectedMinor: c.expectedMinor, actualMinor: c.actualMinor, message: c.message },
        });
    } else if (existing.closedActualMinor !== c.actualMinor) {
      await tx.discrepancy.update({
        where: { id: existing.id },
        data: {
          status: 'open',
          expectedMinor: c.expectedMinor,
          actualMinor: c.actualMinor,
          message: c.message,
          resolution: null,
          resolvedAt: null,
          resolvedById: null,
          closedActualMinor: null,
        },
      });
      await record('finance.discrepancy_reopened', existing.id);
      await unreconcile(tx, tenantId, s);
      result.opened++;
    }
  } else if (existing && existing.status === 'open') {
    await tx.discrepancy.update({
      where: { id: existing.id },
      data: {
        status: 'resolved',
        resolution: 'Cleared by the system: the figures now agree.',
        resolvedAt: new Date(),
        resolvedById: null,
        closedActualMinor: existing.actualMinor,
      },
    });
    await record('finance.discrepancy_closed', existing.id);
    result.closed++;
  }
  return result;
}

/** A settlement that gains a problem is no longer reconciled. */
async function unreconcile(tx: Tx, tenantId: string, s: Subject): Promise<void> {
  const batchIds = new Set<string>();
  if (s.itemId) {
    const item = await tx.settlementItem.findFirst({
      where: { id: s.itemId, tenantId },
      select: { batchId: true },
    });
    if (item) batchIds.add(item.batchId);
  }
  if (s.orderId) {
    const items = await tx.settlementItem.findMany({
      where: { tenantId, orderId: s.orderId },
      select: { batchId: true },
    });
    for (const i of items) batchIds.add(i.batchId);
  }
  if (batchIds.size)
    await tx.settlementBatch.updateMany({
      where: { tenantId, id: { in: [...batchIds] }, reconciledAt: { not: null } },
      data: { reconciledAt: null, reconciledById: null },
    });
}

/**
 * Cash collected for each order: what matched statement lines report (any parcel of the order, duplicates and ignored lines
 * excluded) and, separately, what a person recorded as collected by hand (voided entries excluded).
 */
export async function collectedForOrders(
  tx: Tx,
  tenantId: string,
  orderIds: string[],
): Promise<Map<string, { statementMinor: number; manualMinor: number }>> {
  const out = new Map<string, { statementMinor: number; manualMinor: number }>();
  if (!orderIds.length) return out;
  const statements = await tx.settlementItem.groupBy({
    by: ['orderId'],
    where: { tenantId, orderId: { in: orderIds }, matchStatus: 'matched', kind: 'cod' },
    _sum: { collectedMinor: true },
  });
  const manual = await tx.codReceipt.groupBy({
    by: ['orderId'],
    where: { tenantId, orderId: { in: orderIds }, voidedAt: null },
    _sum: { amountMinor: true },
  });
  for (const r of statements)
    out.set(r.orderId as string, { statementMinor: r._sum.collectedMinor ?? 0, manualMinor: 0 });
  for (const r of manual) {
    const e = out.get(r.orderId) ?? { statementMinor: 0, manualMinor: 0 };
    e.manualMinor = r._sum.amountMinor ?? 0;
    out.set(r.orderId, e);
  }
  return out;
}

/**
 * Re-evaluate the discrepancies that belong to whole parcels (short, over, cash before delivery, cash on a closed order)
 * and to single lines (a delivery charge that differs from the booking's, a net the file got wrong).
 */
export async function evaluate(
  tx: Tx,
  audit: AuditService,
  tenantId: string,
  scope: { orderIds?: Iterable<string>; itemIds?: Iterable<string> },
): Promise<SyncResult & { checked: number }> {
  const total = { opened: 0, closed: 0, checked: 0 };
  const add = (r: SyncResult) => {
    total.opened += r.opened;
    total.closed += r.closed;
  };

  const orderIds = [...new Set(scope.orderIds ?? [])];
  if (orderIds.length) {
    const orders = await tx.order.findMany({
      where: { tenantId, id: { in: orderIds } },
      select: { id: true, orderNumber: true, status: true, codAmountMinor: true },
    });
    const collected = await collectedForOrders(tx, tenantId, orderIds);
    for (const o of orders) {
      const parts = collected.get(o.id) ?? { statementMinor: 0, manualMinor: 0 };
      const c = parts.statementMinor + parts.manualMinor;
      // Who says so, in the words of each message: a courier's statement, a person's own entry, or both.
      const who =
        parts.manualMinor === 0
          ? 'the courier reported'
          : parts.statementMinor === 0
            ? 'you recorded as collected'
            : 'the courier reported and you recorded as collected, together,';
      const whoNow = parts.manualMinor === 0 ? 'the courier reports' : who;
      const pos = cashPosition({
        status: o.status as OrderStatusName,
        codAmountMinor: o.codAmountMinor,
        collectedMinor: c,
      });
      const label = `Order #${o.orderNumber}`;
      const conditions: Record<string, Condition | null> = {
        short_paid:
          pos.state === 'partial'
            ? {
                expectedMinor: pos.expectedMinor,
                actualMinor: c,
                message: `${label}: ${who} ${money(c)} of ${money(pos.expectedMinor)}. ${money(pos.outstandingMinor)} is still owed.`,
              }
            : null,
        over_paid:
          pos.state === 'overpaid'
            ? {
                expectedMinor: pos.expectedMinor,
                actualMinor: c,
                message: `${label}: ${who} ${money(c)}, ${money(pos.excessMinor)} more than the ${money(pos.expectedMinor)} due.${parts.manualMinor > 0 && parts.statementMinor > 0 ? ' The same cash may have been counted twice: void your entry if the statement already includes it.' : ''}`,
              }
            : null,
        cash_before_delivery:
          pos.state === 'cash_before_delivery'
            ? {
                expectedMinor: pos.expectedMinor,
                actualMinor: c,
                message: `${label}: ${whoNow} ${money(c)} collected but the order is not marked delivered.`,
              }
            : null,
        cash_on_closed_order:
          pos.state === 'cash_on_closed_order'
            ? {
                expectedMinor: 0,
                actualMinor: c,
                message: `${label} is ${o.status.replace(/_/g, ' ')}, yet ${whoNow} ${money(c)} collected.`,
              }
            : null,
      };
      for (const type of Object.keys(conditions) as DiscrepancyType[]) {
        add(
          await syncDiscrepancy(tx, audit, tenantId, {
            type,
            subjectKey: `order:${o.id}`,
            orderId: o.id,
            condition: conditions[type] ?? null,
          }),
        );
      }
      total.checked++;
    }
  }

  const itemIds = [...new Set(scope.itemIds ?? [])];
  if (itemIds.length) {
    const items = await tx.settlementItem.findMany({
      where: { tenantId, id: { in: itemIds } },
      include: {
        shipment: { select: { deliveryFeeMinor: true } },
        order: { select: { orderNumber: true } },
      },
    });
    for (const i of items) {
      const counted = i.matchStatus !== 'duplicate' && i.matchStatus !== 'ignored';
      const where = `Line ${i.lineNo}${i.order ? ` (order #${i.order.orderNumber})` : ''}`;
      const fee = i.shipment?.deliveryFeeMinor ?? null;
      await syncDiscrepancy(tx, audit, tenantId, {
        type: 'fee_differs',
        subjectKey: `item:${i.id}`,
        itemId: i.id,
        orderId: i.orderId,
        condition:
          counted &&
          i.matchStatus === 'matched' &&
          fee !== null &&
          i.deliveryChargeMinor > 0 &&
          i.deliveryChargeMinor !== fee
            ? {
                expectedMinor: fee,
                actualMinor: i.deliveryChargeMinor,
                message: `${where}: the courier charged ${money(i.deliveryChargeMinor)} for delivery; the booking said ${money(fee)}.`,
              }
            : null,
      }).then(add);
      await syncDiscrepancy(tx, audit, tenantId, {
        type: 'file_arithmetic',
        subjectKey: `item:${i.id}`,
        itemId: i.id,
        orderId: i.orderId,
        condition:
          counted && i.fileNetMinor !== null && i.fileNetMinor !== i.netMinor
            ? {
                expectedMinor: i.netMinor,
                actualMinor: i.fileNetMinor,
                message: `${where}: the file says it pays ${money(i.fileNetMinor)} but its own figures come to ${money(i.netMinor)}.`,
              }
            : null,
      }).then(add);
      total.checked++;
    }
  }
  return total;
}
