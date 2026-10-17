import { failImportJob, processImportJob } from '@orderloop/catalog';
import { loadDotEnv, loadServerEnv } from '@orderloop/contracts/server';
import { Database } from '@orderloop/db';
import { Worker } from 'bullmq';
import { Redis } from 'ioredis';
import { z } from 'zod';

/** What the API puts on the queue: ids only. Re-validated here, because the worker must not trust what comes out of Redis. */
const ImportJobData = z.object({ tenantId: z.string().uuid(), importId: z.string().uuid() });

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

  const shutdown = async (signal: string) => {
    console.log(`[worker] ${signal} received, finishing the current job and shutting down`);
    await imports.close(); // waits for the job in flight
    await db.disconnect();
    connection.disconnect();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

main();
