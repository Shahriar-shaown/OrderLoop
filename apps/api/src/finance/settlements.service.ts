import { createHash, randomUUID } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import type {
  Discrepancy as DiscrepancyDto,
  SettlementBatch as BatchDto,
  SettlementBatchDetail,
  SettlementCounts,
  SettlementImportBody,
  SettlementImportResult,
  SettlementItem as ItemDto,
  SettlementItemDetail,
  SettlementTotals,
} from '@orderloop/contracts';
import { Database, isUniqueViolation, type Prisma, type Tx } from '@orderloop/db';
import {
  decideMatch,
  parseSettlementCsv,
  settlementItemKeyMaterial,
  settlementNet,
  type MatchCandidate,
  type SettlementRow,
} from '@orderloop/domain';
import { AuditService } from '../audit/audit.service.js';
import { ApiError } from '../common/api-error.js';
import type { AuthContext } from '../common/endpoint.js';
import { evaluate } from './discrepancies.js';

type ItemRow = Prisma.SettlementItemGetPayload<{
  include: { order: { select: { orderNumber: true; codAmountMinor: true } } };
}>;
type DiscRow = Prisma.DiscrepancyGetPayload<{
  include: { order: { select: { orderNumber: true } } };
}>;

const EMPTY_COUNTS: SettlementCounts = {
  matched: 0,
  unmatched: 0,
  ambiguous: 0,
  unallocated: 0,
  duplicate: 0,
  ignored: 0,
};
const EMPTY_TOTALS: SettlementTotals = { collectedMinor: 0, chargesMinor: 0, netMinor: 0 };
const sha = (text: string) => createHash('sha256').update(text).digest('hex');

/** The same statement saved with different line endings, a BOM or trailing blanks is still the same statement. */
const normalise = (csv: string) =>
  csv
    .replace(/^﻿/, '')
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((l) => l.trimEnd())
    .join('\n')
    .trim();

class DryRun extends Error {
  constructor(readonly result: SettlementImportResult) {
    super('dry run');
  }
}

export const discrepancyDto = (d: DiscRow): DiscrepancyDto => ({
  id: d.id,
  type: d.type,
  status: d.status,
  itemId: d.itemId,
  shipmentId: d.shipmentId,
  orderId: d.orderId,
  orderNumber: d.order?.orderNumber ?? null,
  expectedMinor: d.expectedMinor,
  actualMinor: d.actualMinor,
  message: d.message,
  resolution: d.resolution,
  resolvedAt: d.resolvedAt?.toISOString() ?? null,
  createdAt: d.createdAt.toISOString(),
});

@Injectable()
export class SettlementsService {
  constructor(
    private readonly db: Database,
    private readonly audit: AuditService,
  ) {}

  // ---- presenting ----------------------------------------------------------------------------------------------------

  private async itemDtos(tx: Tx, tenantId: string, rows: ItemRow[]): Promise<ItemDto[]> {
    const orderIds = [...new Set(rows.map((r) => r.orderId).filter((x): x is string => !!x))];
    const itemIds = rows.map((r) => r.id);
    const open = await tx.discrepancy.findMany({
      where: {
        tenantId,
        status: 'open',
        OR: [
          { itemId: { in: itemIds } },
          ...(orderIds.length ? [{ orderId: { in: orderIds } }] : []),
        ],
      },
      include: { order: { select: { orderNumber: true } } },
      orderBy: { createdAt: 'asc' },
    });
    return rows.map((r) => ({
      id: r.id,
      batchId: r.batchId,
      lineNo: r.lineNo,
      kind: r.kind,
      transactionId: r.transactionId,
      consignmentId: r.consignmentId,
      trackingCode: r.trackingCode,
      reference: r.reference,
      phone: r.phone,
      date: r.itemDate.toISOString().slice(0, 10),
      collectedMinor: r.collectedMinor,
      deliveryChargeMinor: r.deliveryChargeMinor,
      codFeeMinor: r.codFeeMinor,
      returnChargeMinor: r.returnChargeMinor,
      otherDeductionMinor: r.otherDeductionMinor,
      netMinor: r.netMinor,
      expectedMinor: r.order ? r.order.codAmountMinor : null,
      fileNetMinor: r.fileNetMinor,
      note: r.note,
      matchStatus: r.matchStatus,
      matchMethod: r.matchMethod,
      matchNote: r.matchNote,
      orderId: r.orderId,
      orderNumber: r.order?.orderNumber ?? null,
      shipmentId: r.shipmentId,
      duplicateOfId: r.duplicateOfId,
      discrepancies: open
        .filter(
          (d) =>
            d.itemId === r.id ||
            (r.orderId !== null && d.orderId === r.orderId && d.itemId === null),
        )
        .map(discrepancyDto),
    }));
  }

  private async batchSummary(tx: Tx, tenantId: string, batchId: string): Promise<BatchDto> {
    const b = await tx.settlementBatch.findFirst({ where: { id: batchId, tenantId } });
    if (!b) throw ApiError.notFound('Settlement not found');
    const grouped = await tx.settlementItem.groupBy({
      by: ['matchStatus'],
      where: { tenantId, batchId },
      _count: { _all: true },
    });
    const counts = { ...EMPTY_COUNTS };
    for (const g of grouped) counts[g.matchStatus] = g._count._all;
    const sums = await tx.settlementItem.aggregate({
      where: { tenantId, batchId, matchStatus: { notIn: ['duplicate', 'ignored'] } },
      _sum: {
        collectedMinor: true,
        deliveryChargeMinor: true,
        codFeeMinor: true,
        returnChargeMinor: true,
        otherDeductionMinor: true,
        netMinor: true,
      },
    });
    const orderIds = (
      await tx.settlementItem.findMany({
        where: { tenantId, batchId, orderId: { not: null } },
        select: { orderId: true },
        distinct: ['orderId'],
      })
    ).map((i) => i.orderId as string);
    const openDiscrepancies = await tx.discrepancy.count({
      where: {
        tenantId,
        status: 'open',
        OR: [{ item: { batchId } }, ...(orderIds.length ? [{ orderId: { in: orderIds } }] : [])],
      },
    });
    // What the orders this statement covers were owed, against the cash it reports for them.
    const covered = orderIds.length
      ? await tx.order.aggregate({
          where: { tenantId, id: { in: orderIds } },
          _sum: { codAmountMinor: true },
        })
      : null;
    const reported = await tx.settlementItem.aggregate({
      where: { tenantId, batchId, matchStatus: 'matched', kind: 'cod' },
      _sum: { collectedMinor: true },
    });
    const expectedMinor = covered?._sum.codAmountMinor ?? 0;
    const creator = b.createdById
      ? await tx.user.findFirst({ where: { id: b.createdById }, select: { name: true } })
      : null;
    const s = sums._sum;
    const needs = counts.unmatched + counts.ambiguous + openDiscrepancies > 0;
    return {
      id: b.id,
      provider: b.provider,
      fileName: b.fileName,
      statementRef: b.statementRef,
      rowCount: b.rowCount,
      createdAt: b.createdAt.toISOString(),
      createdByName: creator?.name ?? null,
      reconciledAt: b.reconciledAt?.toISOString() ?? null,
      status: needs ? 'needs_attention' : b.reconciledAt ? 'reconciled' : 'ready',
      counts,
      openDiscrepancies,
      totals: {
        collectedMinor: s.collectedMinor ?? 0,
        chargesMinor:
          (s.deliveryChargeMinor ?? 0) +
          (s.codFeeMinor ?? 0) +
          (s.returnChargeMinor ?? 0) +
          (s.otherDeductionMinor ?? 0),
        netMinor: s.netMinor ?? 0,
      },
      expectedMinor,
      differenceMinor: (reported._sum.collectedMinor ?? 0) - expectedMinor,
    };
  }

  private async batchDetail(
    tx: Tx,
    tenantId: string,
    batchId: string,
  ): Promise<SettlementBatchDetail> {
    const summary = await this.batchSummary(tx, tenantId, batchId);
    const rows = await tx.settlementItem.findMany({
      where: { tenantId, batchId },
      orderBy: { lineNo: 'asc' },
      include: { order: { select: { orderNumber: true, codAmountMinor: true } } },
    });
    const issues: string[] = [];
    if (summary.counts.unmatched)
      issues.push(`${summary.counts.unmatched} line(s) are not tied to any order`);
    if (summary.counts.ambiguous)
      issues.push(
        `${summary.counts.ambiguous} line(s) could be more than one order and need a person to choose`,
      );
    if (summary.openDiscrepancies)
      issues.push(`${summary.openDiscrepancies} discrepancy(ies) are open`);
    return {
      ...summary,
      items: await this.itemDtos(tx, tenantId, rows),
      issues,
      canReconcile: issues.length === 0,
    };
  }

  async listBatches(auth: AuthContext, provider?: string): Promise<BatchDto[]> {
    return this.db.withContext({ tenantId: auth.tenantId }, async (tx) => {
      const batches = await tx.settlementBatch.findMany({
        where: { tenantId: auth.tenantId, ...(provider ? { provider: provider as never } : {}) },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: 200,
        select: { id: true },
      });
      const out: BatchDto[] = [];
      for (const b of batches) out.push(await this.batchSummary(tx, auth.tenantId, b.id));
      return out;
    });
  }

  getBatch(auth: AuthContext, id: string): Promise<SettlementBatchDetail> {
    return this.db.withContext({ tenantId: auth.tenantId }, (tx) =>
      this.batchDetail(tx, auth.tenantId, id),
    );
  }

  async listUnmatched(auth: AuthContext): Promise<ItemDto[]> {
    return this.db.withContext({ tenantId: auth.tenantId }, async (tx) => {
      const rows = await tx.settlementItem.findMany({
        where: { tenantId: auth.tenantId, matchStatus: { in: ['unmatched', 'ambiguous'] } },
        orderBy: [{ itemDate: 'asc' }, { lineNo: 'asc' }],
        take: 1000,
        include: { order: { select: { orderNumber: true, codAmountMinor: true } } },
      });
      return this.itemDtos(tx, auth.tenantId, rows);
    });
  }

  private async itemDetail(tx: Tx, tenantId: string, id: string): Promise<SettlementItemDetail> {
    const row = await tx.settlementItem.findFirst({
      where: { id, tenantId },
      include: { order: { select: { orderNumber: true, codAmountMinor: true } } },
    });
    if (!row) throw ApiError.notFound('Statement line not found');
    const [dto] = await this.itemDtos(tx, tenantId, [row]);
    const events = await tx.settlementItemEvent.findMany({
      where: { tenantId, itemId: id },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    });
    const actors = [...new Set(events.map((e) => e.actorUserId).filter((x): x is string => !!x))];
    const users = actors.length
      ? await tx.user.findMany({ where: { id: { in: actors } }, select: { id: true, name: true } })
      : [];
    const names = new Map(users.map((u) => [u.id, u.name]));
    return {
      ...dto!,
      history: events.map((e) => ({
        id: e.id,
        action: e.action,
        actorName: e.actorUserId ? (names.get(e.actorUserId) ?? null) : null,
        note: e.note,
        createdAt: e.createdAt.toISOString(),
      })),
    };
  }

  getItem(auth: AuthContext, id: string): Promise<SettlementItemDetail> {
    return this.db.withContext({ tenantId: auth.tenantId }, (tx) =>
      this.itemDetail(tx, auth.tenantId, id),
    );
  }

  // ---- importing -----------------------------------------------------------------------------------------------------

  async import(
    auth: AuthContext,
    body: SettlementImportBody,
    ip: string | null,
  ): Promise<SettlementImportResult> {
    if (body.provider === 'mock')
      throw new ApiError(400, 'validation_failed', 'Request validation failed', [
        {
          path: 'provider',
          message: 'The simulated courier moves no money, so it has no settlements',
        },
      ]);
    const parsed = parseSettlementCsv(body.csv);
    const empty = {
      dryRun: body.dryRun,
      alreadyImported: false,
      batchId: null,
      rows: 0,
      errors: parsed.errors,
      fatal: parsed.fatal,
      counts: EMPTY_COUNTS,
      totals: EMPTY_TOTALS,
      discrepancies: 0,
    };
    if (parsed.fatal || parsed.errors.length) {
      // A file that cannot be read exactly is refused whole: nothing is half-imported.
      if (body.dryRun) return empty;
      throw new ApiError(
        400,
        'validation_failed',
        parsed.fatal ?? 'The file has errors. Nothing was imported.',
        parsed.errors.map((e) => ({ path: `line ${e.line}`, message: e.message })),
      );
    }

    const fileHash = sha(`${body.provider}\n${normalise(body.csv)}`);
    const ctx = { tenantId: auth.tenantId, userId: auth.userId };
    try {
      return await this.db.withContext(ctx, async (tx) => {
        const result = await this.importInTx(tx, auth, body, parsed.rows, fileHash, ip);
        if (body.dryRun) throw new DryRun(result);
        return result;
      });
    } catch (error) {
      if (error instanceof DryRun) return error.result;
      // Two identical uploads at once: the database let one in. The other is the same file, already imported.
      if (isUniqueViolation(error)) {
        return this.db.withContext(ctx, async (tx) => {
          const b = await tx.settlementBatch.findFirst({
            where: { tenantId: auth.tenantId, fileHash },
          });
          if (!b) throw error;
          return this.alreadyImported(tx, auth.tenantId, b.id, body.dryRun);
        });
      }
      throw error;
    }
  }

  private async alreadyImported(
    tx: Tx,
    tenantId: string,
    batchId: string,
    dryRun: boolean,
  ): Promise<SettlementImportResult> {
    const s = await this.batchSummary(tx, tenantId, batchId);
    return {
      dryRun,
      alreadyImported: true,
      batchId,
      rows: s.rowCount,
      errors: [],
      fatal: null,
      counts: s.counts,
      totals: s.totals,
      discrepancies: s.openDiscrepancies,
    };
  }

  private async importInTx(
    tx: Tx,
    auth: AuthContext,
    body: SettlementImportBody,
    rows: SettlementRow[],
    fileHash: string,
    ip: string | null,
  ): Promise<SettlementImportResult> {
    const tenantId = auth.tenantId;
    const known = await tx.settlementBatch.findFirst({ where: { tenantId, fileHash } });
    if (known) return this.alreadyImported(tx, tenantId, known.id, body.dryRun);

    const batch = await tx.settlementBatch.create({
      data: {
        tenantId,
        provider: body.provider,
        fileName: body.fileName ?? null,
        statementRef: body.statementRef ?? null,
        fileHash,
        rowCount: rows.length,
        createdById: auth.userId,
      },
    });

    // The parcels these lines could be about: only this courier's, found by the identifiers the file actually uses.
    const consignments = new Set<string>();
    const trackings = new Set<string>();
    const references = new Set<string>();
    const numbers = new Set<number>();
    for (const r of rows) {
      if (r.consignmentId) consignments.add(r.consignmentId);
      if (r.trackingCode) trackings.add(r.trackingCode);
      const ref = r.reference?.trim();
      if (ref) {
        if (/^OL-\d+(?:-\d+)?$/i.test(ref)) references.add(ref.toUpperCase());
        const bare = /^#?(\d{1,9})$/.exec(ref);
        if (bare) numbers.add(Number(bare[1]));
      }
    }
    const lower = (set: Set<string>) =>
      [...set].flatMap((v) => [v, v.toLowerCase(), v.toUpperCase()]);
    const shipments = await tx.shipment.findMany({
      where: {
        tenantId,
        provider: body.provider,
        status: { notIn: ['booking_failed'] },
        OR: [
          ...(consignments.size ? [{ providerConsignmentId: { in: lower(consignments) } }] : []),
          ...(trackings.size ? [{ trackingCode: { in: lower(trackings) } }] : []),
          ...(references.size ? [{ providerReference: { in: [...references] } }] : []),
          ...(numbers.size ? [{ order: { orderNumber: { in: [...numbers] } } }] : []),
        ],
      },
      include: { order: { select: { orderNumber: true, shipPhone: true } } },
    });
    const candidates: MatchCandidate[] = shipments.map((s) => ({
      shipmentId: s.id,
      orderId: s.orderId,
      orderNumber: s.order.orderNumber,
      consignmentId: s.providerConsignmentId,
      trackingCode: s.trackingCode,
      reference: s.providerReference,
      shipPhone: s.order.shipPhone,
    }));

    const keys = rows.map((r) => sha(settlementItemKeyMaterial(body.provider, r)));
    const existing = await tx.settlementItem.findMany({
      where: { tenantId, itemKey: { in: keys }, matchStatus: { not: 'duplicate' } },
      select: { id: true, itemKey: true },
    });
    const firstSeen = new Map(existing.map((e) => [e.itemKey, e.id]));

    const items: Prisma.SettlementItemCreateManyInput[] = [];
    const events: Prisma.SettlementItemEventCreateManyInput[] = [];
    const counts = { ...EMPTY_COUNTS };
    let collected = 0;
    let charges = 0;
    let net = 0;
    const touchedOrders = new Set<string>();
    const touchedItems: string[] = [];

    rows.forEach((r, idx) => {
      const id = randomUUID();
      const key = keys[idx]!;
      const duplicateOf = firstSeen.get(key) ?? null;
      const base = {
        id,
        tenantId,
        batchId: batch.id,
        lineNo: r.line,
        itemKey: key,
        kind: r.kind,
        transactionId: r.transactionId,
        consignmentId: r.consignmentId,
        trackingCode: r.trackingCode,
        reference: r.reference,
        phone: r.phone,
        itemDate: new Date(`${r.date}T00:00:00Z`),
        collectedMinor: r.collectedMinor,
        deliveryChargeMinor: r.deliveryChargeMinor,
        codFeeMinor: r.codFeeMinor,
        returnChargeMinor: r.returnChargeMinor,
        otherDeductionMinor: r.otherDeductionMinor,
        netMinor: settlementNet(r),
        fileNetMinor: r.fileNetMinor,
        note: r.note,
        raw: r as unknown as Prisma.InputJsonValue,
      };
      const event = (action: string, note: string | null, data?: object) =>
        events.push({
          tenantId,
          itemId: id,
          action,
          actorUserId: auth.userId,
          note,
          ...(data ? { data: data as Prisma.InputJsonValue } : {}),
        });

      if (duplicateOf) {
        items.push({
          ...base,
          matchStatus: 'duplicate',
          duplicateOfId: duplicateOf,
          matchNote: 'The same line was already recorded',
        });
        event('imported', `Line ${r.line}`);
        event('duplicate', 'Identical to a line that is already recorded; not counted', {
          duplicateOf,
        });
        counts.duplicate++;
        return;
      }
      firstSeen.set(key, id); // a repeat later in this same file is a duplicate of this line

      let status: 'matched' | 'unmatched' | 'ambiguous' | 'unallocated';
      let match: Partial<Prisma.SettlementItemCreateManyInput> = {};
      let note: string | null = null;
      if (r.kind === 'adjustment' && !r.consignmentId && !r.trackingCode && !r.reference) {
        status = 'unallocated';
        note = 'A charge that belongs to no parcel';
      } else {
        const d = decideMatch(r, candidates);
        if (d.outcome === 'matched') {
          status = 'matched';
          match = { shipmentId: d.shipmentId, orderId: d.orderId, matchMethod: d.method };
          note = `Matched by ${d.method.replace('_', ' ')}`;
          touchedOrders.add(d.orderId);
        } else {
          status = d.outcome;
          note = d.reason;
        }
      }
      items.push({ ...base, ...match, matchStatus: status, matchNote: note });
      touchedItems.push(id);
      event('imported', `Line ${r.line}`);
      event(status === 'matched' ? 'auto_matched' : status, note);
      counts[status]++;
      collected += r.collectedMinor;
      charges +=
        r.deliveryChargeMinor + r.codFeeMinor + r.returnChargeMinor + r.otherDeductionMinor;
      net += settlementNet(r);
    });

    await tx.settlementItem.createMany({ data: items });
    await tx.settlementItemEvent.createMany({ data: events });
    await evaluate(tx, this.audit, tenantId, { orderIds: touchedOrders, itemIds: touchedItems });
    await this.audit.record(tx, {
      tenantId,
      actorUserId: auth.userId,
      action: 'settlement.imported',
      targetType: 'settlement_batch',
      targetId: batch.id,
      metadata: {
        provider: body.provider,
        rows: rows.length,
        ...counts,
        fileHash: fileHash.slice(0, 16),
        dryRun: body.dryRun,
      },
      ip,
    });
    const summary = await this.batchSummary(tx, tenantId, batch.id);
    return {
      dryRun: body.dryRun,
      alreadyImported: false,
      batchId: batch.id,
      rows: rows.length,
      errors: [],
      fatal: null,
      counts,
      totals: { collectedMinor: collected, chargesMinor: charges, netMinor: net },
      discrepancies: summary.openDiscrepancies,
    };
  }

  // ---- reconciling and manual decisions ----------------------------------------------------------------------------------

  async reconcile(
    auth: AuthContext,
    id: string,
    ip: string | null,
  ): Promise<SettlementBatchDetail> {
    return this.db.withContext({ tenantId: auth.tenantId, userId: auth.userId }, async (tx) => {
      const locked = await tx.$queryRaw<{ id: string }[]>`
        SELECT id FROM settlement_batches WHERE tenant_id = ${auth.tenantId}::uuid AND id = ${id}::uuid FOR UPDATE`;
      if (!locked[0]) throw ApiError.notFound('Settlement not found');
      const detail = await this.batchDetail(tx, auth.tenantId, id);
      // Never "reconciled" while anything is unmatched, in doubt, or different from what was expected.
      if (!detail.canReconcile)
        throw new ApiError(
          409,
          'settlement_has_issues',
          `This settlement cannot be reconciled yet: ${detail.issues.join('; ')}.`,
        );
      if (!detail.reconciledAt) {
        await tx.settlementBatch.update({
          where: { id },
          data: { reconciledAt: new Date(), reconciledById: auth.userId },
        });
        await this.audit.record(tx, {
          tenantId: auth.tenantId,
          actorUserId: auth.userId,
          action: 'settlement.reconciled',
          targetType: 'settlement_batch',
          targetId: id,
          metadata: { rows: detail.rowCount, ...detail.counts },
          ip,
        });
      }
      return this.batchDetail(tx, auth.tenantId, id);
    });
  }

  private async lockItem(tx: Tx, tenantId: string, id: string) {
    const locked = await tx.$queryRaw<{ id: string }[]>`
      SELECT id FROM settlement_items WHERE tenant_id = ${tenantId}::uuid AND id = ${id}::uuid FOR UPDATE`;
    if (!locked[0]) throw ApiError.notFound('Statement line not found');
    return tx.settlementItem.findFirstOrThrow({
      where: { id, tenantId },
      include: { batch: true },
    });
  }

  private async decide(
    auth: AuthContext,
    id: string,
    ip: string | null,
    reason: string,
    action: 'manual_matched' | 'unmatched' | 'ignored',
    apply: (
      tx: Tx,
      item: Awaited<ReturnType<SettlementsService['lockItem']>>,
    ) => Promise<{
      data: Prisma.SettlementItemUncheckedUpdateInput;
      orders: string[];
      note: string;
    }>,
  ): Promise<SettlementItemDetail> {
    return this.db.withContext({ tenantId: auth.tenantId, userId: auth.userId }, async (tx) => {
      const item = await this.lockItem(tx, auth.tenantId, id);
      const { data, orders, note } = await apply(tx, item);
      await tx.settlementItem.update({ where: { id }, data });
      await tx.settlementItemEvent.create({
        data: {
          tenantId: auth.tenantId,
          itemId: id,
          action,
          actorUserId: auth.userId,
          note: `${note} Reason: ${reason}`,
          data: {
            from: { status: item.matchStatus, shipmentId: item.shipmentId, orderId: item.orderId },
          },
        },
      });
      // A decision about a line changes what its settlement says: it is no longer reconciled until checked again.
      await tx.settlementBatch.update({
        where: { id: item.batchId },
        data: { reconciledAt: null, reconciledById: null },
      });
      await evaluate(tx, this.audit, auth.tenantId, { orderIds: orders, itemIds: [id] });
      await this.audit.record(tx, {
        tenantId: auth.tenantId,
        actorUserId: auth.userId,
        action: `settlement.item_${action}`,
        targetType: 'settlement_item',
        targetId: id,
        metadata: { batchId: item.batchId, line: item.lineNo, reason },
        ip,
      });
      return this.itemDetail(tx, auth.tenantId, id);
    });
  }

  match(
    auth: AuthContext,
    id: string,
    body: { shipmentId: string; reason: string },
    ip: string | null,
  ) {
    return this.decide(auth, id, ip, body.reason, 'manual_matched', async (tx, item) => {
      if (item.matchStatus !== 'unmatched' && item.matchStatus !== 'ambiguous')
        throw new ApiError(
          409,
          'conflict',
          'Only an unmatched or doubtful line can be matched. Undo its match first.',
        );
      const shipment = await tx.shipment.findFirst({
        where: { id: body.shipmentId, tenantId: auth.tenantId },
      });
      if (!shipment) throw ApiError.notFound('Shipment not found');
      if (shipment.provider !== item.batch.provider)
        throw new ApiError(
          409,
          'conflict',
          'That parcel was booked with a different courier than this statement is from.',
        );
      if (shipment.simulated || shipment.status === 'booking_failed')
        throw new ApiError(
          409,
          'conflict',
          'That shipment is not a real booking, so no money can belong to it.',
        );
      return {
        data: {
          matchStatus: 'matched',
          matchMethod: 'manual',
          matchNote: 'Matched by a person',
          shipmentId: shipment.id,
          orderId: shipment.orderId,
        } as Prisma.SettlementItemUncheckedUpdateInput,
        orders: [shipment.orderId],
        note: `Matched by hand to shipment ${shipment.providerReference}.`,
      };
    });
  }

  unmatch(auth: AuthContext, id: string, reason: string, ip: string | null) {
    return this.decide(auth, id, ip, reason, 'unmatched', async (_tx, item) => {
      if (item.matchStatus !== 'matched')
        throw new ApiError(409, 'conflict', 'Only a matched line can be unmatched.');
      return {
        data: {
          matchStatus: 'unmatched',
          matchMethod: null,
          matchNote: 'Match undone by a person',
          shipmentId: null,
          orderId: null,
        },
        orders: item.orderId ? [item.orderId] : [],
        note: 'The match was undone.',
      };
    });
  }

  ignore(auth: AuthContext, id: string, reason: string, ip: string | null) {
    return this.decide(auth, id, ip, reason, 'ignored', async (_tx, item) => {
      if (!['unmatched', 'ambiguous', 'unallocated'].includes(item.matchStatus))
        throw new ApiError(
          409,
          'conflict',
          'Only a line that is not tied to an order can be ignored. Undo its match first.',
        );
      return {
        data: { matchStatus: 'ignored', matchNote: 'Ignored by a person: not ours' },
        orders: [],
        note: 'The line was set aside as not ours.',
      };
    });
  }
}
