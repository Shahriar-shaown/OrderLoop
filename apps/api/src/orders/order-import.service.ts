import { createHash } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import type { OrderImportBody, OrderImportPreview, OrderImportResult } from '@orderloop/contracts';
import { Database, type Tx } from '@orderloop/db';
import {
  calculateOrderTotals,
  OrderTotalsError,
  ORDER_IMPORT_LIMITS,
  parseOrdersCsv,
  type ParsedOrder,
  type RowError,
} from '@orderloop/domain';
import { AuditService } from '../audit/audit.service.js';
import { ApiError } from '../common/api-error.js';
import type { AuthContext } from '../common/endpoint.js';
import { OrdersService } from './orders.service.js';

/** A stable key per (file, order): re-uploading the same file finds the orders it already made instead of making more. */
const keyFor = (fileHash: string, ref: string): string =>
  `csv:${fileHash}:${ref.replace(/[^A-Za-z0-9._-]/g, '_')}:${createHash('sha256').update(ref).digest('hex').slice(0, 8)}`.slice(
    0,
    100,
  );

interface Checked {
  fileHash: string;
  valid: { order: ParsedOrder; key: string; variantIds: Map<string, string>; totalMinor: number }[];
  errors: RowError[];
  fatal: string | null;
  totalRows: number;
  orderCount: number;
}

@Injectable()
export class OrderImportService {
  constructor(
    private readonly db: Database,
    private readonly orders: OrdersService,
    private readonly audit: AuditService,
  ) {}

  /** Parse, then check each order against the catalog and work out its total, exactly as creating it would. */
  private async check(tx: Tx, tenantId: string, csv: string): Promise<Checked> {
    const fileHash = createHash('sha256').update(csv).digest('hex').slice(0, 16);
    const parsed = parseOrdersCsv(csv);
    if (parsed.fatal)
      return { fileHash, valid: [], errors: [], fatal: parsed.fatal, totalRows: 0, orderCount: 0 };

    const skus = [...new Set(parsed.orders.flatMap((o) => o.items.map((i) => i.sku)))];
    const variants = await tx.productVariant.findMany({
      where: { tenantId, sku: { in: skus } },
      select: {
        id: true,
        sku: true,
        priceMinor: true,
        archivedAt: true,
        product: { select: { status: true } },
      },
    });
    const bySku = new Map(variants.map((v) => [v.sku, v]));
    const errors = [...parsed.errors];
    const valid: Checked['valid'] = [];
    for (const order of parsed.orders) {
      const before = errors.length;
      const variantIds = new Map<string, string>();
      for (const item of order.items) {
        const v = bySku.get(item.sku);
        if (!v) errors.push({ row: item.row, message: `sku ${item.sku} is not in your catalog` });
        else if (v.archivedAt || v.product.status === 'ARCHIVED')
          errors.push({
            row: item.row,
            message: `sku ${item.sku} is archived and cannot be ordered`,
          });
        else variantIds.set(item.sku, v.id);
      }
      let totalMinor = 0;
      if (errors.length === before) {
        try {
          totalMinor = calculateOrderTotals({
            lines: order.items.map((i) => ({
              quantity: i.quantity,
              unitPriceMinor: i.unitPriceMinor ?? bySku.get(i.sku)!.priceMinor,
              discountMinor: i.discountMinor,
            })),
            discountMinor: order.discountMinor,
            deliveryChargeMinor: order.deliveryChargeMinor,
            advancePaidMinor: order.advancePaidMinor,
          }).totalMinor;
        } catch (error) {
          if (!(error instanceof OrderTotalsError)) throw error;
          errors.push({ row: order.row, message: `Order ${order.ref}: ${error.message}` });
        }
      }
      if (errors.length === before)
        valid.push({ order, key: keyFor(fileHash, order.ref), variantIds, totalMinor });
    }
    errors.sort((a, b) => a.row - b.row);
    return {
      fileHash,
      valid,
      errors,
      fatal: null,
      totalRows: parsed.totalRows,
      orderCount: parsed.orderCount,
    };
  }

  private async alreadyDone(tx: Tx, tenantId: string, keys: string[]): Promise<Set<string>> {
    if (keys.length === 0) return new Set();
    const rows = await tx.order.findMany({
      where: { tenantId, idempotencyKey: { in: keys } },
      select: { idempotencyKey: true },
    });
    return new Set(rows.map((r) => r.idempotencyKey!));
  }

  /** What importing this file would do, without creating anything. */
  async validate(auth: AuthContext, body: OrderImportBody): Promise<OrderImportPreview> {
    return this.db.withContext({ tenantId: auth.tenantId }, async (tx) => {
      const c = await this.check(tx, auth.tenantId, body.csv);
      if (c.fatal)
        return {
          fatal: c.fatal,
          totalRows: 0,
          orderCount: 0,
          validOrders: 0,
          alreadyImported: 0,
          errorCount: 0,
          errors: [],
          totalMinor: 0,
        };
      const done = await this.alreadyDone(
        tx,
        auth.tenantId,
        c.valid.map((v) => v.key),
      );
      const fresh = c.valid.filter((v) => !done.has(v.key));
      return {
        fatal: null,
        totalRows: c.totalRows,
        orderCount: c.orderCount,
        validOrders: fresh.length,
        alreadyImported: c.valid.length - fresh.length,
        errorCount: c.errors.length,
        errors: c.errors.slice(0, ORDER_IMPORT_LIMITS.maxErrors),
        totalMinor: fresh.reduce((n, v) => n + v.totalMinor, 0),
      };
    });
  }

  /**
   * Create the orders, as pending confirmation (an import never reserves stock: a person confirms them, and that is when
   * stock is held). Each order is its own transaction with its own idempotency key, so a failed one does not stop the rest
   * and uploading the same file twice creates nothing the second time.
   */
  async apply(
    auth: AuthContext,
    body: OrderImportBody,
    ip: string | null,
  ): Promise<OrderImportResult> {
    const checked = await this.db.withContext({ tenantId: auth.tenantId }, async (tx) => {
      const c = await this.check(tx, auth.tenantId, body.csv);
      const done = await this.alreadyDone(
        tx,
        auth.tenantId,
        c.valid.map((v) => v.key),
      );
      return { c, done };
    });
    const { c, done } = checked;
    if (c.fatal) throw new ApiError('validation_failed', c.fatal);

    const errors: RowError[] = [...c.errors];
    const orderNumbers: number[] = [];
    let created = 0;
    let alreadyImported = 0;
    for (const v of c.valid) {
      if (done.has(v.key)) {
        alreadyImported++;
        continue;
      }
      const o = v.order;
      try {
        const detail = await this.orders.create(
          auth,
          {
            customer: { name: o.customerName, phone: o.phone },
            address: {
              recipientName: o.recipientName,
              phone: o.phone,
              line1: o.line1,
              area: o.area,
              district: o.district,
              division: o.division,
              postalCode: o.postalCode,
            },
            items: o.items.map((i) => ({
              variantId: v.variantIds.get(i.sku)!,
              quantity: i.quantity,
              ...(i.unitPriceMinor !== null ? { unitPriceMinor: i.unitPriceMinor } : {}),
              discountMinor: i.discountMinor,
            })),
            discountMinor: o.discountMinor,
            deliveryChargeMinor: o.deliveryChargeMinor,
            advancePaidMinor: o.advancePaidMinor,
            source: o.source,
            sourceReference: o.sourceReference,
            notes: o.notes,
            idempotencyKey: v.key,
          },
          ip,
        );
        created++;
        orderNumbers.push(detail.orderNumber);
      } catch (error) {
        errors.push({
          row: o.row,
          message: `Order ${o.ref}: ${error instanceof ApiError ? (error.detail ?? error.code) : 'could not be saved'}`,
        });
      }
    }
    errors.sort((a, b) => a.row - b.row);
    await this.db.withContext({ tenantId: auth.tenantId, userId: auth.userId }, (tx) =>
      this.audit.record(tx, {
        tenantId: auth.tenantId,
        actorUserId: auth.userId,
        action: 'orders.imported',
        metadata: { created, alreadyImported, failed: errors.length },
        ip,
      }),
    );
    return {
      created,
      alreadyImported,
      failed: errors.length,
      errors: errors.slice(0, ORDER_IMPORT_LIMITS.maxErrors),
      orderNumbers,
    };
  }
}
