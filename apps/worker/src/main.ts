import { Worker } from 'bullmq';
import { Redis } from 'ioredis';
import { loadDotEnv, loadServerEnv } from '@orderloop/contracts/server';

// Queues are added per phase (courier-sync, reconciliation, ...). M0 only proves
// the process can connect to Redis and run a BullMQ worker.
const SYSTEM_QUEUE = 'system';

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

  const connection = new Redis(env.REDIS_URL, { maxRetriesPerRequest: null });
  connection.on('error', (err) => console.error('[worker] redis error:', describe(err)));

  const worker = new Worker(SYSTEM_QUEUE, async (job) => ({ handled: job.name }), { connection });
  worker.on('ready', () => console.log(`[worker] ready, listening on queue "${SYSTEM_QUEUE}"`));
  worker.on('error', (err) => console.error('[worker] error:', describe(err)));

  const shutdown = async (signal: string) => {
    console.log(`[worker] ${signal} received, shutting down`);
    await worker.close();
    connection.disconnect();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

main();
