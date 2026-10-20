import { Injectable } from '@nestjs/common';
import type { CsvExport, OrderFilters } from '@orderloop/contracts';
import { Database, Prisma } from '@orderloop/db';
import { assertPaisa, IMPORT_COLUMNS, paisaToBdtString, toCsv } from '@orderloop/domain';
import { AuditService } from '../audit/audit.service.js';
import { ApiError } from '../common/api-error.js';
import type { AuthContext } from '../common/endpoint.js';
import { LONG_TX } from '../common/long-tx.js';
import { orderBy, orderWhere } from '../orders/order-query.js';

/** More than this and the file is refused rather than truncated silently; a business this big needs a different tool. */
const MAX_EXPORT_ROWS = 50_000;

/** Counted before the file is built, so an oversized export is refused outright instead of cut short. */
function assertExportable(rows: number | bigint): void {
  if (Number(rows) > MAX_EXPORT_ROWS)
    throw new ApiError(
      'validation_failed',
      `This export has ${Number(rows)} rows; the limit is ${MAX_EXPORT_ROWS}. Narrow it down and try again.`,
    );
}

const stamp = (): string => new Date().toISOString().slice(0, 10);

@Injectable()
export class ExportsService {
  constructor(
    private readonly db: Database,
    private readonly audit: AuditService,
  ) {}

  /** The catalog in exactly the columns the product import accepts, so an exported file can be edited and imported back. */
  products(auth: AuthContext, ip: string | null): Promise<CsvExport> {
    return this.db.withContext(
      { tenantId: auth.tenantId, userId: auth.userId },
      async (tx) => {
        const where = {
          tenantId: auth.tenantId,
          archivedAt: null,
          product: { status: 'ACTIVE' },
        } as const;
        assertExportable(await tx.productVariant.count({ where }));
        const variants = await tx.productVariant.findMany({
          where,
          orderBy: [{ product: { createdAt: 'asc' } }, { createdAt: 'asc' }],
          include: { product: { include: { category: true, supplier: true } } },
        });
        const header = [...IMPORT_COLUMNS];
        const rows = variants.map((v) => {
          const attributes = (v.attributes ?? {}) as Record<string, string>;
          const row: Record<(typeof IMPORT_COLUMNS)[number], string | number | null> = {
            product_name: v.product.name,
            sku: v.sku,
            price: paisaToBdtString(assertPaisa(v.priceMinor)),
            category: v.product.category?.name ?? null,
            unit: v.product.unit,
            variant_name: v.name || null,
            size: attributes['size'] ?? null,
            colour: attributes['colour'] ?? null,
            cost: v.costMinor === null ? null : paisaToBdtString(assertPaisa(v.costMinor)),
            reorder_point: v.reorderPoint,
            barcode: v.barcode,
            description: v.product.description,
            supplier: v.product.supplier?.name ?? null,
            // Stock is not exported here: opening stock is for new variants only, so a re-import never double-counts it.
            opening_stock: null,
            location: null,
          };
          return header.map((h) => row[h]);
        });
        await this.audit.record(tx, {
          tenantId: auth.tenantId,
          actorUserId: auth.userId,
          action: 'export.products',
          metadata: { rows: rows.length },
          ip,
        });
        return {
          filename: `products-${stamp()}.csv`,
          rowCount: rows.length,
          csv: toCsv([header, ...rows]),
        };
      },
      LONG_TX,
    );
  }

  /** Stock per variant and location, for stock-takes and accounting. */
  stock(auth: AuthContext, ip: string | null): Promise<CsvExport> {
    return this.db.withContext(
      { tenantId: auth.tenantId, userId: auth.userId },
      async (tx) => {
        const [counted] = await tx.$queryRaw<{ n: bigint }[]>`
        SELECT count(*) AS n FROM stock_levels WHERE tenant_id = ${auth.tenantId}::uuid`;
        assertExportable(counted?.n ?? 0);
        const lines = await tx.$queryRaw<
          {
            sku: string;
            product_name: string;
            variant_name: string;
            location_name: string;
            on_hand: number;
            reserved: number;
            damaged: number;
            reorder_point: number;
          }[]
        >`
        SELECT v.sku, p.name AS product_name, v.name AS variant_name, loc.name AS location_name,
               l.on_hand, l.reserved, l.damaged, v.reorder_point
        FROM stock_levels l
        JOIN product_variants v ON v.tenant_id = l.tenant_id AND v.id = l.variant_id
        JOIN products p ON p.tenant_id = v.tenant_id AND p.id = v.product_id
        JOIN stock_locations loc ON loc.tenant_id = l.tenant_id AND loc.id = l.location_id
        WHERE l.tenant_id = ${auth.tenantId}::uuid
        ORDER BY v.sku, loc.name`;
        const header = [
          'sku',
          'product_name',
          'variant_name',
          'location',
          'on_hand',
          'reserved',
          'damaged',
          'available',
          'reorder_point',
        ];
        const rows = lines.map((l) => [
          l.sku,
          l.product_name,
          l.variant_name || null,
          l.location_name,
          l.on_hand,
          l.reserved,
          l.damaged,
          l.on_hand - l.reserved,
          l.reorder_point,
        ]);
        await this.audit.record(tx, {
          tenantId: auth.tenantId,
          actorUserId: auth.userId,
          action: 'export.stock',
          metadata: { rows: rows.length },
          ip,
        });
        return {
          filename: `stock-${stamp()}.csv`,
          rowCount: rows.length,
          csv: toCsv([header, ...rows]),
        };
      },
      LONG_TX,
    );
  }

  /** Orders matching the list filters, one row per order line, with the order's figures repeated on each line. */
  orders(auth: AuthContext, filters: OrderFilters, ip: string | null): Promise<CsvExport> {
    return this.db.withContext(
      { tenantId: auth.tenantId, userId: auth.userId },
      async (tx) => {
        const t = await tx.tenant.findUnique({
          where: { id: auth.tenantId },
          select: { timezone: true },
        });
        const where = orderWhere(auth.tenantId, filters, t?.timezone ?? 'Asia/Dhaka');
        const source = Prisma.sql`
        FROM orders o
        JOIN customers c ON c.tenant_id = o.tenant_id AND c.id = o.customer_id
        JOIN order_items i ON i.tenant_id = o.tenant_id AND i.order_id = o.id
        WHERE ${where}`;
        const [counted] = await tx.$queryRaw<{ n: bigint }[]>(
          Prisma.sql`SELECT count(*) AS n ${source}`,
        );
        assertExportable(counted?.n ?? 0);
        const lines = await tx.$queryRaw<
          Record<string, string | number | Date | null>[]
        >(Prisma.sql`
        SELECT o.order_number, o.status, o.created_at, c.name AS customer_name, o.ship_name, o.ship_phone,
               o.ship_line1, o.ship_area, o.ship_district, o.ship_division, o.ship_postal_code,
               i.sku, i.product_name, i.variant_name, i.quantity, i.unit_price_minor, i.discount_minor AS line_discount_minor,
               i.line_total_minor, o.discount_minor, o.delivery_charge_minor, o.advance_paid_minor, o.total_minor,
               o.cod_amount_minor, o.source, o.source_reference, o.notes
        ${source}
        ORDER BY ${orderBy('createdAt', 'desc')}, i.position`);
        const money = (v: string | number | Date | null | undefined) =>
          paisaToBdtString(assertPaisa(Number(v ?? 0)));
        const header = [
          'order_number',
          'status',
          'created_at',
          'customer_name',
          'recipient_name',
          'phone',
          'address_line',
          'area',
          'district',
          'division',
          'postal_code',
          'sku',
          'product_name',
          'variant_name',
          'quantity',
          'unit_price',
          'line_discount',
          'line_total',
          'discount',
          'delivery_charge',
          'advance_paid',
          'total',
          'cod_amount',
          'source',
          'source_reference',
          'notes',
        ];
        const rows = lines.map((l) => [
          l['order_number'] as number,
          l['status'] as string,
          (l['created_at'] as Date).toISOString(),
          l['customer_name'] as string,
          l['ship_name'] as string,
          // Local form (01712345678): a leading + would be read as a formula by spreadsheets.
          (l['ship_phone'] as string).replace(/^\+880/, '0'),
          l['ship_line1'] as string,
          l['ship_area'] as string,
          l['ship_district'] as string,
          l['ship_division'] as string,
          (l['ship_postal_code'] as string | null) ?? null,
          l['sku'] as string,
          l['product_name'] as string,
          (l['variant_name'] as string) || null,
          l['quantity'] as number,
          money(l['unit_price_minor']),
          money(l['line_discount_minor']),
          money(l['line_total_minor']),
          money(l['discount_minor']),
          money(l['delivery_charge_minor']),
          money(l['advance_paid_minor']),
          money(l['total_minor']),
          money(l['cod_amount_minor']),
          l['source'] as string,
          (l['source_reference'] as string | null) ?? null,
          (l['notes'] as string | null) ?? null,
        ]);
        await this.audit.record(tx, {
          tenantId: auth.tenantId,
          actorUserId: auth.userId,
          action: 'export.orders',
          metadata: { rows: rows.length },
          ip,
        });
        return {
          filename: `orders-${stamp()}.csv`,
          rowCount: rows.length,
          csv: toCsv([header, ...rows]),
        };
      },
      LONG_TX,
    );
  }
}
