import { QUEUES, buildProviders, channelAvailability, jsonLogger } from '@orderloop/automation';
import { failImportJob, findStalePendingImports, processImportJob } from '@orderloop/catalog';
import { loadDotEnv, loadServerEnv } from '@orderloop/contracts/server';
import { Database } from '@orderloop/db';
import { Queue, Worker } from 'bullmq';
import { Redis } from 'ioredis';
import { z } from 'zod';
import { SWEEP_EVERY_MS, sweepPendingImports } from './sweep-imports.js';
import { PURGE_EVERY_MS, purgeIdempotencyKeys } from './purge-idempotency.js';
import { automationProcessors, logFailedJob, registerTick } from './automation.js';
import { SmtpEmailSender, consoleEmailSender } from './smtp-email.js';

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

async function main(): Promise<void> {
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

  // ---- automation and notifications ---------------------------------------------------------------------------------
  // One repeatable tick (every minute, however many workers run) finds what is due and queues evaluations under
  // deterministic ids; the evaluation and delivery workers do the rest. See docs/automation.md.
  const email =
    env.MAIL_PROVIDER === 'smtp'
      ? new SmtpEmailSender({
          host: env.SMTP_HOST!,
          port: env.SMTP_PORT,
          secure: env.SMTP_SECURE,
          user: env.SMTP_USER,
          password: env.SMTP_PASSWORD,
          from: env.MAIL_FROM,
        })
      : consoleEmailSender((line) => console.log(`[worker] ${line}`));
  const providers = buildProviders(
    {
      nodeEnv: env.NODE_ENV,
      pushProvider: env.PUSH_PROVIDER,
      pushDevOutbox: env.PUSH_DEV_OUTBOX,
      expoAccessToken: env.EXPO_ACCESS_TOKEN,
      smsProvider: env.SMS_PROVIDER,
      whatsappProvider: env.WHATSAPP_PROVIDER,
    },
    email,
    jsonLogger,
  );
  const evaluateQueue = new Queue(QUEUES.evaluate, { connection });
  const deliverQueue = new Queue(QUEUES.deliver, { connection });
  const tickQueue = new Queue(QUEUES.tick, { connection });
  const queues = { evaluate: evaluateQueue, deliver: deliverQueue };
  const now = () => new Date();
  const processors = automationProcessors({
    evaluate: {
      db,
      queues,
      now,
      log: jsonLogger,
      providers: channelAvailability({
        smsProvider: env.SMS_PROVIDER,
        whatsappProvider: env.WHATSAPP_PROVIDER,
      }),
    },
    deliver: { db, providers, now, log: jsonLogger, receiptsQueue: deliverQueue },
    tick: { db, queues, now, log: jsonLogger },
  });
  const automationWorkers = [
    new Worker(QUEUES.tick, processors.tick, { connection, concurrency: 1 }),
    new Worker(QUEUES.evaluate, processors.evaluate, { connection, concurrency: 4 }),
    new Worker(QUEUES.deliver, processors.deliver, { connection, concurrency: 5 }),
  ];
  for (const [i, name] of [QUEUES.tick, QUEUES.evaluate, QUEUES.deliver].entries()) {
    const w = automationWorkers[i]!;
    w.on('error', (err) => console.error(`[worker] ${name} error:`, describe(err)));
    w.on('failed', (j, err) => logFailedJob(jsonLogger, name, j, err));
  }
  await registerTick(tickQueue);
  console.log(
    '[worker] automation ready: tick every minute, queues "automation" and "automation-delivery"',
  );

  const shutdown = async (signal: string) => {
    console.log(`[worker] ${signal} received, finishing the current job and shutting down`);
    clearInterval(sweep);
    clearInterval(purge);
    await queue.close();
    await Promise.all(automationWorkers.map((w) => w.close()));
    await Promise.all([evaluateQueue, deliverQueue, tickQueue].map((q) => q.close()));
    await imports.close(); // waits for the job in flight
    await db.disconnect();
    connection.disconnect();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

main().catch((err: Error) => {
  console.error('[worker] failed to start:', describe(err));
  process.exit(1);
});
