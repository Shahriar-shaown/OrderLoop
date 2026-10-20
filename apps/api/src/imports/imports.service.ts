import { Inject, Injectable, Logger } from '@nestjs/common';
import type { ImportBody, ImportJob, ImportPreview } from '@orderloop/contracts';
import { IMPORT_JOB_OPTIONS, previewImportRows } from '@orderloop/catalog';
import { IMPORT_LIMITS, parseCatalogCsv } from '@orderloop/domain';
import { Database } from '@orderloop/db';
import type { Queue } from 'bullmq';
import { AuditService } from '../audit/audit.service.js';
import { ApiError } from '../common/api-error.js';
import type { AuthContext } from '../common/endpoint.js';
import { IMPORTS_QUEUE, type ImportJobData } from '../queue/queue.module.js';

type Row = {
  id: string;
  kind: string;
  status: 'PENDING' | 'RUNNING' | 'COMPLETED' | 'FAILED';
  totalRows: number | null;
  created: number;
  updated: number;
  failed: number;
  errors: unknown;
  createdAt: Date;
  startedAt: Date | null;
  finishedAt: Date | null;
};

const toJob = (j: Row): ImportJob => ({
  id: j.id,
  kind: j.kind,
  status: j.status,
  totalRows: j.totalRows,
  created: j.created,
  updated: j.updated,
  failed: j.failed,
  errors: (Array.isArray(j.errors) ? j.errors : []) as ImportJob['errors'],
  createdAt: j.createdAt.toISOString(),
  startedAt: j.startedAt?.toISOString() ?? null,
  finishedAt: j.finishedAt?.toISOString() ?? null,
});

/** Imports a business may have waiting or running at once. */
export const MAX_IMPORTS_IN_FLIGHT = 3;
/** A job older than this is presumed stuck and no longer counts against the limit. */
const IN_FLIGHT_WINDOW_MS = 30 * 60_000;

@Injectable()
export class ImportsService {
  private readonly logger = new Logger(ImportsService.name);

  constructor(
    private readonly db: Database,
    private readonly audit: AuditService,
    @Inject(IMPORTS_QUEUE) private readonly queue: Queue<ImportJobData>,
  ) {}

  /**
   * Work out what an import would do, without changing anything: the file's own problems plus the ones the existing
   * catalog would cause (an archived product, a SKU that belongs elsewhere). Shown before the person starts the import.
   */
  async validate(auth: AuthContext, body: ImportBody): Promise<ImportPreview> {
    const parsed = parseCatalogCsv(body.csv);
    if (parsed.fatal)
      return {
        fatal: parsed.fatal,
        totalRows: 0,
        validRows: 0,
        willCreate: 0,
        willUpdate: 0,
        errorCount: 0,
        errors: [],
      };
    const preview = await this.db.withContext({ tenantId: auth.tenantId }, (tx) =>
      previewImportRows(tx, auth.tenantId, parsed.rows),
    );
    const errors = [...parsed.errors, ...preview.problems].sort((a, b) => a.row - b.row);
    return {
      fatal: null,
      totalRows: parsed.totalRows,
      validRows: parsed.rows.length - preview.problems.length,
      willCreate: preview.willCreate,
      willUpdate: preview.willUpdate,
      errorCount: errors.length,
      errors: errors.slice(0, IMPORT_LIMITS.maxErrors),
    };
  }

  /** Record the job, then hand its id to the worker. The request returns at once; the file is processed in the background. */
  async create(auth: AuthContext, body: ImportBody): Promise<ImportJob> {
    const job = await this.db.withContext(
      { tenantId: auth.tenantId, userId: auth.userId },
      async (tx) => {
        // A fair share of the one worker: each business may have a few imports in flight, not an unbounded backlog.
        const inFlight = await tx.importJob.count({
          where: {
            tenantId: auth.tenantId,
            status: { in: ['PENDING', 'RUNNING'] },
            createdAt: { gt: new Date(Date.now() - IN_FLIGHT_WINDOW_MS) },
          },
        });
        if (inFlight >= MAX_IMPORTS_IN_FLIGHT)
          throw new ApiError(
            429,
            'rate_limited',
            `Finish your ${inFlight} running imports before starting another`,
          );
        const created = await tx.importJob.create({
          data: {
            tenantId: auth.tenantId,
            kind: 'products',
            csv: body.csv,
            createdById: auth.userId,
          },
        });
        await this.audit.record(tx, {
          tenantId: auth.tenantId,
          actorUserId: auth.userId,
          action: 'import.queued',
          targetType: 'import',
          targetId: created.id,
        });
        return created;
      },
    );

    try {
      // jobId = importId makes enqueueing idempotent, and the worker claims the row atomically besides.
      await this.queue.add(
        'products',
        { tenantId: auth.tenantId, importId: job.id },
        { jobId: job.id, ...IMPORT_JOB_OPTIONS },
      );
    } catch (error) {
      this.logger.error(
        `could not queue import ${job.id}: ${error instanceof Error ? error.message : 'error'}`,
      );
      await this.db.withContext({ tenantId: auth.tenantId }, (tx) =>
        tx.importJob.update({
          where: { id: job.id },
          data: {
            status: 'FAILED',
            csv: null,
            finishedAt: new Date(),
            errors: [{ row: 0, message: 'The import could not be queued. Try again shortly.' }],
          },
        }),
      );
      throw new ApiError(
        503,
        'internal_error',
        'The import queue is unavailable; try again shortly',
      );
    }
    return toJob(job);
  }

  async get(auth: AuthContext, id: string): Promise<ImportJob> {
    const job = await this.db.withContext({ tenantId: auth.tenantId }, (tx) =>
      tx.importJob.findFirst({ where: { id, tenantId: auth.tenantId } }),
    );
    if (!job) throw ApiError.notFound('Import not found');
    return toJob(job);
  }

  list(auth: AuthContext): Promise<ImportJob[]> {
    return this.db.withContext({ tenantId: auth.tenantId }, async (tx) =>
      (
        await tx.importJob.findMany({
          where: { tenantId: auth.tenantId },
          orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
          take: 20,
        })
      ).map(toJob),
    );
  }
}
