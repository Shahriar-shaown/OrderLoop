import { Injectable } from '@nestjs/common';
import type {
  Product,
  CreateVariantBody,
  ProductBody,
  ProductPage,
  ProductQuery,
  ProductUpdate,
  Variant,
  VariantInput,
  VariantUpdate,
} from '@orderloop/contracts';
import { Database, isUniqueViolation, type Prisma, type Tx } from '@orderloop/db';
import { nameKey } from '@orderloop/domain';
import { AuditService } from '../audit/audit.service.js';
import { ApiError } from '../common/api-error.js';
import { decodeCursor, encodeCursor } from '../common/cursor.js';
import type { AuthContext } from '../common/endpoint.js';
import { idempotent } from '../common/idempotency.js';
import { stockTotals, toProduct, toVariant } from './catalog.mapper.js';

const SKU_TAKEN = (sku: string) =>
  ApiError.conflict(`SKU ${sku} is already used by another variant`);

@Injectable()
export class ProductsService {
  constructor(
    private readonly db: Database,
    private readonly audit: AuditService,
  ) {}

  private async requireCategory(tx: Tx, tenantId: string, categoryId: string): Promise<void> {
    // A category id from another tenant is invisible under row-level security, so it is "not found" here too.
    const found = await tx.category.findFirst({
      where: { id: categoryId, tenantId },
      select: { id: true },
    });
    if (!found)
      throw new ApiError('validation_failed', 'Request validation failed', [
        { path: 'body.categoryId', message: 'Category not found' },
      ]);
  }

  private async requireSupplier(tx: Tx, tenantId: string, supplierId: string): Promise<void> {
    const found = await tx.supplier.findFirst({
      where: { id: supplierId, tenantId, archivedAt: null },
      select: { id: true },
    });
    if (!found)
      throw new ApiError('validation_failed', 'Request validation failed', [
        { path: 'body.supplierId', message: 'Supplier not found' },
      ]);
  }

  private async load(tx: Tx, tenantId: string, id: string): Promise<Product> {
    const product = await tx.product.findFirst({
      where: { id, tenantId },
      include: { variants: { orderBy: { createdAt: 'asc' } } },
    });
    if (!product) throw ApiError.notFound('Product not found');
    return toProduct(
      product,
      product.variants,
      await stockTotals(
        tx,
        tenantId,
        product.variants.map((v) => v.id),
      ),
    );
  }

  async list(auth: AuthContext, query: ProductQuery): Promise<ProductPage> {
    const cursor = query.cursor ? decodeCursor(query.cursor) : undefined;
    return this.db.withContext({ tenantId: auth.tenantId }, async (tx) => {
      const q = query.q ? nameKey(query.q) : undefined;
      const where: Prisma.ProductWhereInput = {
        tenantId: auth.tenantId,
        ...(query.status ? { status: query.status } : {}),
        ...(query.categoryId ? { categoryId: query.categoryId } : {}),
        ...(q
          ? {
              OR: [
                { nameKey: { contains: q } },
                { variants: { some: { sku: { contains: q.toUpperCase() } } } },
              ],
            }
          : {}),
        ...(cursor
          ? {
              AND: [
                {
                  OR: [
                    { createdAt: { lt: cursor.createdAt } },
                    { createdAt: cursor.createdAt, id: { lt: cursor.id } },
                  ],
                },
              ],
            }
          : {}),
      };
      const rows = await tx.product.findMany({
        where,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: query.limit + 1,
        include: { variants: { orderBy: { createdAt: 'asc' } } },
      });
      const page = rows.slice(0, query.limit);
      const totals = await stockTotals(
        tx,
        auth.tenantId,
        page.flatMap((p) => p.variants.map((v) => v.id)),
      );
      const last = page.at(-1);
      return {
        items: page.map((p) => toProduct(p, p.variants, totals)),
        nextCursor:
          rows.length > query.limit && last ? encodeCursor(last.createdAt, last.id) : null,
      };
    });
  }

  get(auth: AuthContext, id: string): Promise<Product> {
    return this.db.withContext({ tenantId: auth.tenantId }, (tx) =>
      this.load(tx, auth.tenantId, id),
    );
  }

  async create(auth: AuthContext, body: ProductBody): Promise<Product> {
    const skus = body.variants.map((v) => v.sku);
    const repeated = skus.find((s, i) => skus.indexOf(s) !== i);
    if (repeated)
      throw new ApiError('validation_failed', 'Request validation failed', [
        { path: 'body.variants', message: `SKU ${repeated} appears more than once` },
      ]);

    try {
      return await idempotent(
        this.db,
        { tenantId: auth.tenantId, userId: auth.userId },
        { scope: 'POST /v1/products', key: body.idempotencyKey, body },
        async (tx) => {
          if (body.categoryId) await this.requireCategory(tx, auth.tenantId, body.categoryId);
          if (body.supplierId) await this.requireSupplier(tx, auth.tenantId, body.supplierId);
          const product = await tx.product.create({
            data: {
              tenantId: auth.tenantId,
              name: body.name,
              nameKey: nameKey(body.name),
              description: body.description ?? null,
              categoryId: body.categoryId ?? null,
              supplierId: body.supplierId ?? null,
              imageUrls: body.imageUrls,
              unit: body.unit,
            },
          });
          for (const v of body.variants) await this.createVariant(tx, auth.tenantId, product.id, v);
          await this.audit.record(tx, {
            tenantId: auth.tenantId,
            actorUserId: auth.userId,
            action: 'product.created',
            targetType: 'product',
            targetId: product.id,
            metadata: { variants: body.variants.length },
          });
          return this.load(tx, auth.tenantId, product.id);
        },
      );
    } catch (error) {
      if (isUniqueViolation(error, 'sku')) throw SKU_TAKEN('that');
      throw error;
    }
  }

  private createVariant(tx: Tx, tenantId: string, productId: string, v: VariantInput) {
    return tx.productVariant.create({
      data: {
        tenantId,
        productId,
        sku: v.sku,
        name: v.name,
        attributes: v.attributes,
        priceMinor: v.priceMinor,
        costMinor: v.costMinor ?? null,
        barcode: v.barcode ?? null,
        reorderPoint: v.reorderPoint,
      },
    });
  }

  async update(auth: AuthContext, id: string, body: ProductUpdate): Promise<Product> {
    return this.db.withContext({ tenantId: auth.tenantId, userId: auth.userId }, async (tx) => {
      const found = await tx.product.findFirst({ where: { id, tenantId: auth.tenantId } });
      if (!found) throw ApiError.notFound('Product not found');
      if (body.categoryId) await this.requireCategory(tx, auth.tenantId, body.categoryId);
      if (body.supplierId) await this.requireSupplier(tx, auth.tenantId, body.supplierId);
      if (body.status === 'ARCHIVED' && found.status !== 'ARCHIVED') {
        const variants = await tx.productVariant.findMany({
          where: { tenantId: auth.tenantId, productId: id, archivedAt: null },
          select: { id: true },
        });
        await this.assertNoActiveReservations(
          tx,
          auth.tenantId,
          variants.map((v) => v.id),
        );
      }
      await tx.product.update({
        where: { id },
        data: {
          ...(body.name !== undefined ? { name: body.name, nameKey: nameKey(body.name) } : {}),
          ...(body.description !== undefined ? { description: body.description } : {}),
          ...(body.categoryId !== undefined ? { categoryId: body.categoryId } : {}),
          ...(body.supplierId !== undefined ? { supplierId: body.supplierId } : {}),
          ...(body.imageUrls !== undefined ? { imageUrls: body.imageUrls } : {}),
          ...(body.unit !== undefined ? { unit: body.unit } : {}),
          ...(body.status !== undefined ? { status: body.status } : {}),
        },
      });
      const action =
        body.status === 'ARCHIVED' && found.status !== 'ARCHIVED'
          ? 'product.archived'
          : 'product.updated';
      await this.audit.record(tx, {
        tenantId: auth.tenantId,
        actorUserId: auth.userId,
        action,
        targetType: 'product',
        targetId: id,
      });
      return this.load(tx, auth.tenantId, id);
    });
  }

  async addVariant(
    auth: AuthContext,
    productId: string,
    body: CreateVariantBody,
  ): Promise<Variant> {
    try {
      return await idempotent(
        this.db,
        { tenantId: auth.tenantId, userId: auth.userId },
        {
          scope: `POST /v1/products/${productId}/variants`,
          key: body.idempotencyKey,
          body,
        },
        async (tx) => {
          const product = await tx.product.findFirst({
            where: { id: productId, tenantId: auth.tenantId },
            select: { id: true },
          });
          if (!product) throw ApiError.notFound('Product not found');
          const v = await this.createVariant(tx, auth.tenantId, productId, body);
          await this.audit.record(tx, {
            tenantId: auth.tenantId,
            actorUserId: auth.userId,
            action: 'variant.created',
            targetType: 'variant',
            targetId: v.id,
          });
          return toVariant(v, new Map());
        },
      );
    } catch (error) {
      if (isUniqueViolation(error, 'sku')) throw SKU_TAKEN(body.sku);
      throw error;
    }
  }

  /**
   * Archiving something that still has promised stock would strand open reservations. Lock the variants exclusively first
   * (in a fixed order): a stock change holding one FOR SHARE finishes (or waits) before we count.
   */
  private async assertNoActiveReservations(tx: Tx, tenantId: string, variantIds: string[]) {
    if (!variantIds.length) return;
    await tx.$queryRaw`SELECT id FROM product_variants WHERE tenant_id = ${tenantId}::uuid AND id = ANY(${variantIds}::uuid[]) ORDER BY id FOR UPDATE`;
    const open = await tx.reservation.count({
      where: { tenantId, variantId: { in: variantIds }, status: 'ACTIVE' },
    });
    if (open > 0)
      throw ApiError.conflict(
        'There are active reservations on this item; release or fulfil them first',
      );
  }

  async updateVariant(auth: AuthContext, id: string, body: VariantUpdate): Promise<Variant> {
    return this.db.withContext({ tenantId: auth.tenantId, userId: auth.userId }, async (tx) => {
      const found = await tx.productVariant.findFirst({ where: { id, tenantId: auth.tenantId } });
      if (!found) throw ApiError.notFound('Variant not found');
      if (body.archived === true && !found.archivedAt)
        await this.assertNoActiveReservations(tx, auth.tenantId, [id]);
      const v = await tx.productVariant.update({
        where: { id },
        data: {
          ...(body.name !== undefined ? { name: body.name } : {}),
          ...(body.attributes !== undefined ? { attributes: body.attributes } : {}),
          ...(body.priceMinor !== undefined ? { priceMinor: body.priceMinor } : {}),
          ...(body.costMinor !== undefined ? { costMinor: body.costMinor } : {}),
          ...(body.barcode !== undefined ? { barcode: body.barcode } : {}),
          ...(body.reorderPoint !== undefined ? { reorderPoint: body.reorderPoint } : {}),
          ...(body.archived !== undefined
            ? { archivedAt: body.archived ? (found.archivedAt ?? new Date()) : null }
            : {}),
        },
      });
      await this.audit.record(tx, {
        tenantId: auth.tenantId,
        actorUserId: auth.userId,
        action: body.archived === true ? 'variant.archived' : 'variant.updated',
        targetType: 'variant',
        targetId: id,
        // Price and cost decide every later order's margin, so an edit keeps the old and the new figure.
        metadata: {
          sku: found.sku,
          ...(body.priceMinor !== undefined
            ? { price: { before: found.priceMinor, after: v.priceMinor } }
            : {}),
          ...(body.costMinor !== undefined
            ? { cost: { before: found.costMinor, after: v.costMinor } }
            : {}),
        },
      });
      return toVariant(v, await stockTotals(tx, auth.tenantId, [id]));
    });
  }
}
