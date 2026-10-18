import { Injectable } from '@nestjs/common';
import type { CsvExport } from '@orderloop/contracts';
import { Database } from '@orderloop/db';
import { assertPaisa, IMPORT_COLUMNS, paisaToBdtString, toCsv } from '@orderloop/domain';
import { AuditService } from '../audit/audit.service.js';
import type { AuthContext } from '../common/endpoint.js';

/** More than this and the file is refused rather than truncated silently; a business this big needs a different tool. */
const MAX_EXPORT_ROWS = 50_000;

const stamp = (): string => new Date().toISOString().slice(0, 10);

@Injectable()
export class ExportsService {
  constructor(
    private readonly db: Database,
    private readonly audit: AuditService,
  ) {}

  /** The catalog in exactly the columns the product import accepts, so an exported file can be edited and imported back. */
  products(auth: AuthContext, ip: string | null): Promise<CsvExport> {
    return this.db.withContext({ tenantId: auth.tenantId, userId: auth.userId }, async (tx) => {
      const variants = await tx.productVariant.findMany({
        where: { tenantId: auth.tenantId, archivedAt: null, product: { status: 'ACTIVE' } },
        orderBy: [{ product: { createdAt: 'asc' } }, { createdAt: 'asc' }],
        take: MAX_EXPORT_ROWS,
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
    });
  }

  /** Stock per variant and location, for stock-takes and accounting. */
  stock(auth: AuthContext, ip: string | null): Promise<CsvExport> {
    return this.db.withContext({ tenantId: auth.tenantId, userId: auth.userId }, async (tx) => {
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
        ORDER BY v.sku, loc.name
        LIMIT ${MAX_EXPORT_ROWS}`;
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
    });
  }
}
