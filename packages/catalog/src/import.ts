import { Database, isUniqueViolation, Prisma, type Tx } from '@orderloop/db';
import {
  IMPORT_LIMITS,
  nameKey,
  parseCatalogCsv,
  type ImportRow,
  type RowError,
} from '@orderloop/domain';
import { ensureDefaultLocation, receiveStock } from './stock.js';

/** A RUNNING job older than this is presumed abandoned by a crashed worker and may be resumed. */
const STALL_MS = 10 * 60_000;

/** A row problem the user can fix by editing the file. */
class RowProblem extends Error {}

export interface ImportInput {
  tenantId: string;
  importId: string;
}

type RowOutcome = 'created' | 'updated';

async function upsertCategory(tx: Tx, tenantId: string, name: string): Promise<string> {
  const key = nameKey(name);
  const existing = await tx.category.findUnique({
    where: { tenantId_nameKey: { tenantId, nameKey: key } },
    select: { id: true },
  });
  if (existing) return existing.id;
  return (
    await tx.category.create({
      data: { tenantId, name: name.trim(), nameKey: key },
      select: { id: true },
    })
  ).id;
}

async function upsertSupplier(tx: Tx, tenantId: string, name: string): Promise<string> {
  const key = nameKey(name);
  const existing = await tx.supplier.findUnique({
    where: { tenantId_nameKey: { tenantId, nameKey: key } },
    select: { id: true, archivedAt: true },
  });
  if (existing) {
    if (existing.archivedAt) throw new RowProblem(`supplier "${name}" is archived`);
    return existing.id;
  }
  return (
    await tx.supplier.create({
      data: { tenantId, name: name.trim(), nameKey: key },
      select: { id: true },
    })
  ).id;
}

/** Size and colour become variant attributes, the same keys the product form writes. */
const attributesOf = (row: ImportRow): Record<string, string> => ({
  ...(row.size ? { size: row.size } : {}),
  ...(row.colour ? { colour: row.colour } : {}),
});

async function upsertLocation(tx: Tx, tenantId: string, name: string): Promise<string> {
  const key = nameKey(name);
  const existing = await tx.stockLocation.findUnique({
    where: { tenantId_nameKey: { tenantId, nameKey: key } },
    select: { id: true, archivedAt: true },
  });
  if (existing) {
    if (existing.archivedAt) throw new RowProblem(`location "${name}" is archived`);
    return existing.id;
  }
  return (
    await tx.stockLocation.create({
      data: { tenantId, name: name.trim(), nameKey: key },
      select: { id: true },
    })
  ).id;
}

async function importRow(
  tx: Tx,
  tenantId: string,
  importId: string,
  createdById: string | null,
  row: ImportRow,
): Promise<RowOutcome> {
  const categoryId = row.category ? await upsertCategory(tx, tenantId, row.category) : null;
  const supplierId = row.supplier ? await upsertSupplier(tx, tenantId, row.supplier) : null;

  const key = nameKey(row.productName);
  let product = await tx.product.findFirst({
    where: { tenantId, nameKey: key },
    orderBy: { createdAt: 'asc' },
  });
  if (product) {
    if (product.status === 'ARCHIVED')
      throw new RowProblem(
        `product "${row.productName}" is archived; restore it before importing into it`,
      );
    if (product.unit !== row.unit)
      throw new RowProblem(`product "${row.productName}" already exists with unit ${product.unit}`);
    const data: Prisma.ProductUncheckedUpdateInput = {};
    if (categoryId && product.categoryId !== categoryId) data.categoryId = categoryId;
    if (supplierId && product.supplierId !== supplierId) data.supplierId = supplierId;
    if (row.description && product.description !== row.description)
      data.description = row.description;
    if (Object.keys(data).length)
      product = await tx.product.update({ where: { id: product.id }, data });
  } else {
    product = await tx.product.create({
      data: {
        tenantId,
        name: row.productName,
        nameKey: key,
        description: row.description,
        categoryId,
        supplierId,
        unit: row.unit,
      },
    });
  }

  const variant = await tx.productVariant.findUnique({
    where: { tenantId_sku: { tenantId, sku: row.sku } },
  });
  if (variant) {
    if (variant.productId !== product.id)
      throw new RowProblem(`sku ${row.sku} already belongs to a different product`);
    await tx.productVariant.update({
      where: { id: variant.id },
      data: {
        ...(row.variantName ? { name: row.variantName } : {}),
        // Merge, so importing a size does not erase a colour set elsewhere.
        ...(row.size || row.colour
          ? {
              attributes: {
                ...(variant.attributes as Record<string, string>),
                ...attributesOf(row),
              },
            }
          : {}),
        priceMinor: row.priceMinor,
        ...(row.costMinor !== null ? { costMinor: row.costMinor } : {}),
        ...(row.barcode ? { barcode: row.barcode } : {}),
        ...(row.reorderPoint ? { reorderPoint: row.reorderPoint } : {}),
        archivedAt: null,
      },
    });
    return 'updated'; // opening stock is for new variants only, so re-importing a file never double-counts stock
  }

  const created = await tx.productVariant.create({
    data: {
      tenantId,
      productId: product.id,
      sku: row.sku,
      name: row.variantName,
      attributes: attributesOf(row),
      priceMinor: row.priceMinor,
      costMinor: row.costMinor,
      barcode: row.barcode,
      reorderPoint: row.reorderPoint,
    },
    select: { id: true },
  });
  if (row.openingStock > 0) {
    const locationId = row.location
      ? await upsertLocation(tx, tenantId, row.location)
      : await ensureDefaultLocation(tx, tenantId);
    await receiveStock(
      tx,
      { tenantId, variantId: created.id, locationId },
      row.openingStock,
      // The key makes a resumed import unable to add the same opening stock twice.
      {
        createdById,
        reason: 'Opening stock (import)',
        referenceType: 'import',
        referenceId: importId,
        idempotencyKey: `import:${importId}:${row.row}`,
      },
    );
  }
  return 'created';
}

export interface ImportPreviewResult {
  willCreate: number;
  willUpdate: number;
  /** Row problems the database would cause (on top of the file's own), by line number. */
  problems: RowError[];
}

/**
 * What applying `rows` would do, decided with the same checks `importRow` makes but writing nothing. Reads only, so it is
 * safe to call repeatedly. The apply step remains the authority (data can change between the check and the import).
 */
export async function previewImportRows(
  tx: Tx,
  tenantId: string,
  rows: readonly ImportRow[],
): Promise<ImportPreviewResult> {
  const problems: RowError[] = [];
  let willCreate = 0;
  let willUpdate = 0;
  // Products this same file would create: later rows of the same product are fine, but must agree on the unit.
  const newProducts = new Map<string, ImportRow>();
  const locations = new Map<string, boolean>();
  const suppliers = new Map<string, boolean>();

  const skus = await tx.productVariant.findMany({
    where: { tenantId, sku: { in: rows.map((r) => r.sku) } },
    select: { sku: true, productId: true },
  });
  const skuProduct = new Map(skus.map((v) => [v.sku, v.productId]));

  for (const row of rows) {
    const key = nameKey(row.productName);
    const product = await tx.product.findFirst({
      where: { tenantId, nameKey: key },
      orderBy: { createdAt: 'asc' },
      select: { id: true, status: true, unit: true },
    });
    const problem = (message: string) => problems.push({ row: row.row, message });

    if (product) {
      if (product.status === 'ARCHIVED') {
        problem(`product "${row.productName}" is archived; restore it before importing into it`);
        continue;
      }
      if (product.unit !== row.unit) {
        problem(`product "${row.productName}" already exists with unit ${product.unit}`);
        continue;
      }
    } else if (newProducts.has(key)) {
      // created earlier in this file
    }

    const existingProductId = skuProduct.get(row.sku);
    if (existingProductId !== undefined && product && existingProductId !== product.id) {
      problem(`sku ${row.sku} already belongs to a different product`);
      continue;
    }
    if (existingProductId !== undefined && !product) {
      problem(`sku ${row.sku} already belongs to a different product`);
      continue;
    }

    if (row.supplier) {
      const k = nameKey(row.supplier);
      if (!suppliers.has(k)) {
        const s = await tx.supplier.findUnique({
          where: { tenantId_nameKey: { tenantId, nameKey: k } },
          select: { archivedAt: true },
        });
        suppliers.set(k, s?.archivedAt != null);
      }
      if (suppliers.get(k)) {
        problem(`supplier "${row.supplier}" is archived`);
        continue;
      }
    }
    if (row.location && row.openingStock > 0 && existingProductId === undefined) {
      const k = nameKey(row.location);
      if (!locations.has(k)) {
        const l = await tx.stockLocation.findUnique({
          where: { tenantId_nameKey: { tenantId, nameKey: k } },
          select: { archivedAt: true },
        });
        locations.set(k, l?.archivedAt != null);
      }
      if (locations.get(k)) {
        problem(`location "${row.location}" is archived`);
        continue;
      }
    }

    if (!product) newProducts.set(key, row);
    if (existingProductId !== undefined) willUpdate++;
    else willCreate++;
  }
  return { willCreate, willUpdate, problems };
}

/**
 * Process one catalog import job. Safe to call more than once for the same job: only one caller can claim it, and a
 * job abandoned mid-way by a crashed worker is resumable (rows are idempotent). Each row runs in its own transaction,
 * so one bad row never loses the good ones; problems are recorded per row for the user to fix.
 *
 * `reclaim: true` is for a queue redelivery (the previous attempt crashed, stalled, or threw): the caller knows no other
 * worker holds the job, so a RUNNING job is taken over at once instead of waiting out the stall timeout.
 *
 * The raw CSV is deleted from the database when processing ends.
 */
export async function processImportJob(
  db: Database,
  { tenantId, importId }: ImportInput,
  log: (message: string) => void = () => undefined,
  options: { reclaim?: boolean } = {},
): Promise<void> {
  const stalledBefore = new Date(Date.now() - STALL_MS);
  const claimed = await db.withContext({ tenantId }, async (tx) => {
    const result = await tx.importJob.updateMany({
      where: {
        id: importId,
        tenantId,
        OR: options.reclaim
          ? [{ status: 'PENDING' }, { status: 'RUNNING' }]
          : [{ status: 'PENDING' }, { status: 'RUNNING', startedAt: { lt: stalledBefore } }],
      },
      data: { status: 'RUNNING', startedAt: new Date() },
    });
    if (result.count !== 1) return null;
    return tx.importJob.findUnique({
      where: { id: importId },
      select: { csv: true, createdById: true },
    });
  });
  if (!claimed) {
    log(`import ${importId}: not claimable (already processed or running)`);
    return;
  }

  const finish = (
    data: Prisma.ImportJobUncheckedUpdateInput,
    action: string,
    metadata: Prisma.InputJsonValue,
  ) =>
    db.withContext({ tenantId }, async (tx) => {
      await tx.importJob.update({
        where: { id: importId },
        data: { ...data, csv: null, finishedAt: new Date() },
      });
      await tx.auditLog.createMany({
        data: [
          {
            tenantId,
            actorUserId: claimed.createdById,
            action,
            targetType: 'import',
            targetId: importId,
            metadata,
          },
        ],
      });
    });

  if (claimed.csv === null) {
    // Nothing to process: the file is gone. Say so rather than leaving the job RUNNING forever.
    await finish(
      {
        status: 'FAILED',
        errors: [{ row: 0, message: 'The uploaded file is no longer available. Upload it again.' }],
      },
      'import.failed',
      { reason: 'file missing' },
    );
    return;
  }
  const parsed = parseCatalogCsv(claimed.csv);
  if (parsed.fatal) {
    await finish(
      { status: 'FAILED', errors: [{ row: 0, message: parsed.fatal }] },
      'import.failed',
      { reason: 'invalid file' },
    );
    return;
  }

  const errors: RowError[] = [...parsed.errors];
  let created = 0;
  let updated = 0;
  for (const row of parsed.rows) {
    try {
      const outcome = await db.withContext({ tenantId }, (tx) =>
        importRow(tx, tenantId, importId, claimed.createdById, row),
      );
      if (outcome === 'created') created++;
      else updated++;
    } catch (error) {
      if (error instanceof RowProblem) errors.push({ row: row.row, message: error.message });
      else if (isUniqueViolation(error))
        errors.push({
          row: row.row,
          message: 'This row conflicts with existing data (duplicate name or SKU)',
        });
      else {
        errors.push({ row: row.row, message: 'This row could not be saved' });
        log(
          `import ${importId}: row ${row.row} failed unexpectedly: ${error instanceof Error ? error.name : 'error'}`,
        );
      }
    }
  }

  errors.sort((a, b) => a.row - b.row);
  const failed = errors.length;
  await finish(
    {
      status: 'COMPLETED',
      totalRows: parsed.totalRows,
      created,
      updated,
      failed,
      errors: errors
        .slice(0, IMPORT_LIMITS.maxErrors)
        .map(({ row, message }) => ({ row, message })),
    },
    'import.completed',
    { created, updated, failed },
  );
  log(`import ${importId}: completed created=${created} updated=${updated} failed=${failed}`);
}

/**
 * Give up on a job for good (the queue exhausted its retries). Marks it FAILED and deletes the stored CSV, so a job that
 * could not be processed never lingers as RUNNING with customer data attached. A job that already finished is left alone.
 */
export async function failImportJob(
  db: Database,
  { tenantId, importId }: ImportInput,
  message: string,
): Promise<void> {
  await db.withContext({ tenantId }, async (tx) => {
    const result = await tx.importJob.updateMany({
      where: { id: importId, tenantId, status: { in: ['PENDING', 'RUNNING'] } },
      data: { status: 'FAILED', csv: null, finishedAt: new Date(), errors: [{ row: 0, message }] },
    });
    if (result.count === 1) {
      await tx.auditLog.createMany({
        data: [
          {
            tenantId,
            action: 'import.failed',
            targetType: 'import',
            targetId: importId,
            metadata: { reason: 'gave up' },
          },
        ],
      });
    }
  });
}

/** How an import is queued. Shared by the API (first attempt) and the worker's sweeper (a missed one), so both queue it alike. */
export const IMPORT_JOB_OPTIONS = {
  attempts: 3,
  backoff: { type: 'exponential' as const, delay: 5000 },
  removeOnComplete: { age: 3600 },
  removeOnFail: { age: 86_400 },
};

/**
 * Imports saved as PENDING for longer than `olderThanMs`: normally they are picked up within seconds, so these were never
 * queued (the API died between saving and queueing) or were lost from the queue. Looks across tenants, which row-level
 * security allows only for this one read (see the import_sweep migration); it returns ids and never the CSV.
 */
export async function findStalePendingImports(
  db: Database,
  olderThanMs: number,
  limit = 100,
): Promise<ImportInput[]> {
  return db.withContext({}, async (tx) => {
    await tx.$executeRaw`SELECT set_config('app.sweep', 'import_jobs', true)`;
    const rows = await tx.importJob.findMany({
      where: { status: 'PENDING', createdAt: { lt: new Date(Date.now() - olderThanMs) } },
      select: { id: true, tenantId: true },
      orderBy: { createdAt: 'asc' },
      take: limit,
    });
    return rows.map((r) => ({ tenantId: r.tenantId, importId: r.id }));
  });
}
