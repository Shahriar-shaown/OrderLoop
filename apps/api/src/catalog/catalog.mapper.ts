import type { Category, Location, Product, Supplier, Variant } from '@orderloop/contracts';
import type { Tx } from '@orderloop/db';

export const toCategory = (c: { id: string; name: string }): Category => ({
  id: c.id,
  name: c.name,
});

export const toLocation = (l: {
  id: string;
  name: string;
  isDefault: boolean;
  archivedAt: Date | null;
}): Location => ({
  id: l.id,
  name: l.name,
  isDefault: l.isDefault,
  archived: l.archivedAt !== null,
});

type VariantRow = {
  id: string;
  productId: string;
  sku: string;
  name: string;
  attributes: unknown;
  priceMinor: number;
  costMinor: number | null;
  barcode: string | null;
  reorderPoint: number;
  archivedAt: Date | null;
};
type ProductRow = {
  id: string;
  name: string;
  description: string | null;
  categoryId: string | null;
  supplierId: string | null;
  imageUrls: string[];
  unit: string;
  status: 'ACTIVE' | 'ARCHIVED';
  createdAt: Date;
};
export type Totals = Map<string, { onHand: number; reserved: number; damaged: number }>;

export function toVariant(v: VariantRow, totals: Totals): Variant {
  const t = totals.get(v.id) ?? { onHand: 0, reserved: 0, damaged: 0 };
  return {
    id: v.id,
    productId: v.productId,
    sku: v.sku,
    name: v.name,
    attributes: (v.attributes ?? {}) as Record<string, string>,
    priceMinor: v.priceMinor,
    costMinor: v.costMinor,
    barcode: v.barcode,
    reorderPoint: v.reorderPoint,
    archived: v.archivedAt !== null,
    stock: {
      onHand: t.onHand,
      reserved: t.reserved,
      available: t.onHand - t.reserved,
      damaged: t.damaged,
    },
  };
}

export function toProduct(p: ProductRow, variants: VariantRow[], totals: Totals): Product {
  return {
    id: p.id,
    name: p.name,
    description: p.description,
    categoryId: p.categoryId,
    supplierId: p.supplierId,
    imageUrls: p.imageUrls,
    unit: p.unit as Product['unit'],
    status: p.status,
    createdAt: p.createdAt.toISOString(),
    variants: variants.map((v) => toVariant(v, totals)),
  };
}

/** Stock summed over every location, for the given variants. */
export async function stockTotals(tx: Tx, tenantId: string, variantIds: string[]): Promise<Totals> {
  if (variantIds.length === 0) return new Map();
  const rows = await tx.stockLevel.groupBy({
    by: ['variantId'],
    where: { tenantId, variantId: { in: variantIds } },
    _sum: { onHand: true, reserved: true, damaged: true },
  });
  return new Map(
    rows.map((r) => [
      r.variantId,
      { onHand: r._sum.onHand ?? 0, reserved: r._sum.reserved ?? 0, damaged: r._sum.damaged ?? 0 },
    ]),
  );
}

export const toSupplier = (s: {
  id: string;
  name: string;
  contactName: string | null;
  phone: string | null;
  email: string | null;
  address: string | null;
  notes: string | null;
  archivedAt: Date | null;
}): Supplier => ({
  id: s.id,
  name: s.name,
  contactName: s.contactName,
  phone: s.phone,
  email: s.email,
  address: s.address,
  notes: s.notes,
  archived: s.archivedAt !== null,
});
