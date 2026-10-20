import { failImportJob, findStalePendingImports, processImportJob } from '@orderloop/catalog';
import { loadDotEnv, loadServerEnv } from '@orderloop/contracts/server';
import { Database } from '@orderloop/db';
import { Queue, Worker } from 'bullmq';
import { Redis } from 'ioredis';
import { z } from 'zod';
import { SWEEP_EVERY_MS, sweepPendingImports } from './sweep-imports.js';
import { PURGE_EVERY_MS, purgeIdempotencyKeys } from './purge-idempotency.js';

/** What the API puts on the queue: ids only. Re-validated here, because the worker must not trust what comes out of Redis. */
const ImportJobData = z.object({ tenantId: z.string().uuid(), importId: z.string().uuid() });
type ImportJobData = z.infer<typeof ImportJobData>;

/** Connection failures surface as AggregateError with an empty message; fall back to the code or the errors inside. */
function describe(err: Error & { code?: string; errors?: Error[] }): string {
  return (
    err.message ||
    err.code ||
    err.errors?.map((e) => e.message || (e as { code?: string }).code).join(', ') ||
    err.name
  );
}

function main(): void {
  loadDotEnv();
  const env = loadServerEnv();

  const db = new Database(env.DATABASE_URL, { max: 5 });
  const connection = new Redis(env.REDIS_URL, { maxRetriesPerRequest: null });
  connection.on('error', (err) => console.error('[worker] redis error:', describe(err)));

  // One job at a time per process keeps database load predictable; scale by running more workers.
  const imports = new Worker(
    'imports',
    async (job) => {
      const data = ImportJobData.parse(job.data);
      // attemptsStarted > 1 means the queue is redelivering: the previous attempt crashed, stalled or threw, so no other
      // worker holds this job and it can be taken over immediately. Rows are idempotent, so resuming is safe.
      await processImportJob(db, data, (message) => console.log(`[worker] ${message}`), {
        reclaim: job.attemptsStarted > 1,
      });
    },
    { connection, concurrency: 1 },
  );
  imports.on('ready', () => console.log('[worker] ready, listening on queue "imports"'));
  imports.on('error', (err) => console.error('[worker] error:', describe(err)));
  imports.on('failed', (job, err) => {
    console.error(`[worker] job ${job?.id ?? '?'} failed: ${describe(err)}`);
    // Out of retries: mark the import FAILED and drop its stored CSV, so it never sits RUNNING forever.
    if (job && job.attemptsMade >= (job.opts.attempts ?? 1)) {
      const parsed = ImportJobData.safeParse(job.data);
      if (parsed.success) {
        failImportJob(
          db,
          parsed.data,
          'The import could not be completed. Try uploading it again.',
        ).catch((e: Error) =>
          console.error(`[worker] could not mark import failed: ${describe(e)}`),
        );
      }
    }
  });

  // The API saves an import and then queues it; if it dies in between, the row sits PENDING with nothing to run it.
  const queue = new Queue<ImportJobData>('imports', { connection });
  const sweep = setInterval(() => {
    sweepPendingImports({
      find: (olderThanMs) => findStalePendingImports(db, olderThanMs),
      queue,
      log: (message) => console.log(`[worker] ${message}`),
    }).catch((e: Error) => console.error(`[worker] sweep failed: ${describe(e)}`));
  }, SWEEP_EVERY_MS);

  // Idempotency keys only matter while a client might still retry; drop them after a day.
  const purge = setInterval(() => {
    purgeIdempotencyKeys({
      purge: (olderThanSeconds) => db.purgeIdempotencyKeys(olderThanSeconds),
      log: (message) => console.log(`[worker] ${message}`),
    }).catch((e: Error) => console.error(`[worker] key purge failed: ${describe(e)}`));
  }, PURGE_EVERY_MS);

  const shutdown = async (signal: string) => {
    console.log(`[worker] ${signal} received, finishing the current job and shutting down`);
    clearInterval(sweep);
    clearInterval(purge);
    await queue.close();
    await imports.close(); // waits for the job in flight
    await db.disconnect();
    connection.disconnect();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

main();
