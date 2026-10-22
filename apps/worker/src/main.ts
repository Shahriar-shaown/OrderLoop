import {
  META_QUEUES,
  MetaGraphClient,
  QUEUES,
  SOCIAL_PURGE_EVERY_MS,
  SOCIAL_SWEEP_EVERY_MS,
  SecretBox,
  TIKTOK_PURGE_EVERY_MS,
  TIKTOK_QUEUES,
  TIKTOK_SWEEP_EVERY_MS,
  TikTokShopClient,
  buildProviders,
  channelAvailability,
  jsonLogger,
  purgeSocialData,
  purgeTikTokData,
  sweepReceivedSocialEvents,
  sweepReceivedTikTokEvents,
} from '@orderloop/automation';
import {
  failImportJob,
  findStalePendingImports,
  findStalledRunningImports,
  processImportJob,
  tiktokOrderSink,
} from '@orderloop/catalog';
import { loadDotEnv, loadServerEnv } from '@orderloop/contracts/server';
import { Database } from '@orderloop/db';
import { Queue, Worker } from 'bullmq';
import { Redis } from 'ioredis';
import { z } from 'zod';
import { SWEEP_EVERY_MS, sweepPendingImports } from './sweep-imports.js';
import { PURGE_EVERY_MS, purgeIdempotencyKeys } from './purge-idempotency.js';
import { automationProcessors, logFailedJob, registerTick } from './automation.js';
import { metaProcessors, onEventJobFailed, registerHealthSchedule } from './meta.js';
import { onTikTokEventJobFailed, registerTikTokSchedules, tiktokProcessors } from './tiktok.js';
import { describe } from './describe-error.js';
import { startHeartbeat } from './heartbeat.js';
import { TENANT_PURGE_QUEUE, registerTenantPurge, runTenantPurge } from './tenant-purge.js';
import { startHealthServer } from './health-server.js';
import { installProcessErrorHandlers, logUnhandled } from './unhandled.js';
import { createWorkerMetrics } from './worker-metrics.js';
import { SmtpEmailSender, consoleEmailSender } from './smtp-email.js';

/** What the API puts on the queue: ids only. Re-validated here, because the worker must not trust what comes out of Redis. */
const ImportJobData = z.object({ tenantId: z.string().uuid(), importId: z.string().uuid() });
type ImportJobData = z.infer<typeof ImportJobData>;

async function main(): Promise<void> {
  installProcessErrorHandlers();
  loadDotEnv();
  const env = loadServerEnv(process.env, { service: 'worker' });

  const db = new Database(env.DATABASE_URL, { max: 5 });
  const connection = new Redis(env.REDIS_URL, { maxRetriesPerRequest: null });
  connection.on('error', (err) => console.error('[worker] redis error:', describe(err)));

  // Liveness signal in Redis (read by the API's /metrics as the worker heartbeat age), plus an HTTP health and metrics server
  // for the container healthcheck and Prometheus: /health/live, /health/ready (Redis, PostgreSQL, heartbeat) and /metrics.
  const heartbeat = startHeartbeat({
    redis: connection,
    log: (message) => console.error(`[worker] ${message}`),
  });
  const metrics = createWorkerMetrics({
    redis: connection,
    db,
    lastHeartbeatAt: heartbeat.lastSuccessAt,
  });

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
      findStalledRunning: (olderThanMs) => findStalledRunningImports(db, olderThanMs),
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

  // ---- Meta (Facebook Page / Instagram) inbox ------------------------------------------------------------------------------
  // Events are stored by the API's webhook first and queued second; this worker turns them into drafts, a sweeper queues the
  // ones the API could not (Redis down), retention deletes old data, and a daily job checks the connections. See docs/meta.md.
  const metaEventsQueue = new Queue(META_QUEUES.events, { connection });
  const metaHealthQueue = new Queue(META_QUEUES.health, { connection });
  const metaLive =
    env.META_MODE === 'live' && env.META_APP_ID && env.META_APP_SECRET && env.META_GRAPH_VERSION;
  const meta = metaProcessors({
    process: { db, log: jsonLogger },
    health: metaLive
      ? {
          db,
          log: jsonLogger,
          now,
          graph: new MetaGraphClient({
            fetch,
            version: env.META_GRAPH_VERSION!,
            appId: env.META_APP_ID!,
            appSecret: env.META_APP_SECRET!,
          }),
          vault: new SecretBox({
            keyId: env.COURIER_CREDENTIALS_KEY_ID,
            key: env.COURIER_CREDENTIALS_KEY,
            oldKeys: env.COURIER_CREDENTIALS_OLD_KEYS,
            keyName: 'COURIER_CREDENTIALS_KEY',
          }),
        }
      : undefined,
  });
  const metaWorkers = [
    new Worker(META_QUEUES.events, meta.event, { connection, concurrency: 4 }),
    new Worker(META_QUEUES.health, meta.health, { connection, concurrency: 1 }),
  ];
  metaWorkers[0]!.on('error', (err) => console.error('[worker] meta-events error:', describe(err)));
  metaWorkers[0]!.on('failed', (j, err) => {
    onEventJobFailed(db, jsonLogger, j, err).catch((e: Error) =>
      console.error(`[worker] could not mark Meta event failed: ${describe(e)}`),
    );
  });
  metaWorkers[1]!.on('error', (err) => console.error('[worker] meta-health error:', describe(err)));
  await registerHealthSchedule(metaHealthQueue);
  const metaSweep = setInterval(() => {
    sweepReceivedSocialEvents({ db, queue: metaEventsQueue, log: jsonLogger }).catch((e: Error) =>
      console.error(`[worker] Meta sweep failed: ${describe(e)}`),
    );
  }, SOCIAL_SWEEP_EVERY_MS);
  const metaPurge = setInterval(() => {
    purgeSocialData({ db, retentionDays: env.META_RETENTION_DAYS, log: jsonLogger }).catch(
      (e: Error) => console.error(`[worker] Meta purge failed: ${describe(e)}`),
    );
  }, SOCIAL_PURGE_EVERY_MS);
  console.log(
    `[worker] Meta ready (${env.META_MODE}): queue "${META_QUEUES.events}", daily health check${metaLive ? '' : ' (idle: no live Meta app configured)'}`,
  );

  // ---- TikTok Shop (read-only order mirror + stock) -----------------------------------------------------------------------------
  // Events are stored by the API's webhook first and queued second; this worker fetches the order from TikTok (live) and updates
  // the mirror and the stock. A sweeper queues the events the API could not (Redis down), retention deletes old data, and three
  // repeatable jobs run on one queue: the catch-up check (webhooks are dropped after about 12 hours of failures), the renewal of
  // access tokens, and a daily health check. See docs/tiktok-shop.md.
  const tiktokEventsQueue = new Queue(TIKTOK_QUEUES.events, { connection });
  const tiktokMaintenanceQueue = new Queue(TIKTOK_QUEUES.maintenance, { connection });
  const tiktokLive = Boolean(
    env.TIKTOK_MODE === 'live' && env.TIKTOK_APP_KEY && env.TIKTOK_APP_SECRET,
  );
  const tiktokVault = new SecretBox({
    keyId: env.COURIER_CREDENTIALS_KEY_ID,
    key: env.COURIER_CREDENTIALS_KEY,
    oldKeys: env.COURIER_CREDENTIALS_OLD_KEYS,
    keyName: 'COURIER_CREDENTIALS_KEY',
  });
  const tiktokClient = tiktokLive
    ? new TikTokShopClient({
        fetch,
        appKey: env.TIKTOK_APP_KEY!,
        appSecret: env.TIKTOK_APP_SECRET!,
        authHost: env.TIKTOK_AUTH_HOST,
        apiHost: env.TIKTOK_API_HOST,
        version: env.TIKTOK_API_VERSION,
      })
    : undefined;
  const tiktok = tiktokProcessors({
    process: {
      db,
      log: jsonLogger,
      now,
      sink: tiktokOrderSink,
      metrics: metrics.tiktok,
      live: tiktokClient ? { client: tiktokClient, vault: tiktokVault } : undefined,
    },
    live: tiktokClient
      ? {
          db,
          log: jsonLogger,
          now,
          client: tiktokClient,
          vault: tiktokVault,
          sink: tiktokOrderSink,
          metrics: metrics.tiktok,
        }
      : undefined,
  });
  const tiktokWorkers = [
    new Worker(TIKTOK_QUEUES.events, tiktok.event, { connection, concurrency: 4 }),
    new Worker(TIKTOK_QUEUES.maintenance, tiktok.maintenance, { connection, concurrency: 1 }),
  ];
  tiktokWorkers[0]!.on('error', (err) =>
    console.error('[worker] tiktok-events error:', describe(err)),
  );
  tiktokWorkers[0]!.on('failed', (j, err) => {
    onTikTokEventJobFailed(db, jsonLogger, j, err).catch((e: Error) =>
      console.error(`[worker] could not mark TikTok event failed: ${describe(e)}`),
    );
  });
  tiktokWorkers[1]!.on('error', (err) =>
    console.error('[worker] tiktok-maintenance error:', describe(err)),
  );
  await registerTikTokSchedules(tiktokMaintenanceQueue);
  const tiktokSweep = setInterval(() => {
    sweepReceivedTikTokEvents({ db, queue: tiktokEventsQueue, log: jsonLogger }).catch((e: Error) =>
      console.error(`[worker] TikTok sweep failed: ${describe(e)}`),
    );
  }, TIKTOK_SWEEP_EVERY_MS);
  const tiktokPurge = setInterval(() => {
    purgeTikTokData({ db, orderRetentionDays: env.TIKTOK_RETENTION_DAYS, log: jsonLogger }).catch(
      (e: Error) => console.error(`[worker] TikTok purge failed: ${describe(e)}`),
    );
  }, TIKTOK_PURGE_EVERY_MS);
  console.log(
    `[worker] TikTok ready (${env.TIKTOK_MODE}): queue "${TIKTOK_QUEUES.events}", sync every 10 minutes, token renewal, daily health check${tiktokLive ? '' : ' (idle: no live TikTok app configured)'}`,
  );

  // ---- business deletion ------------------------------------------------------------------------------------------------
  // An owner's deletion request marks the business; once its grace period is over this hourly job deletes it for good (the
  // database function re-checks, so cancelled or already purged businesses are skipped). See docs/privacy-and-deletion.md.
  const purgeQueue = new Queue(TENANT_PURGE_QUEUE, { connection });
  const purgeWorker = new Worker(
    TENANT_PURGE_QUEUE,
    async () => {
      await runTenantPurge({ db, log: jsonLogger });
    },
    { connection, concurrency: 1 },
  );
  purgeWorker.on('error', (err) => console.error('[worker] tenant-purge error:', describe(err)));
  await registerTenantPurge(purgeQueue);
  console.log(`[worker] tenant purge ready: queue "${TENANT_PURGE_QUEUE}", hourly`);

  // Instrument every queue's worker (counts and durations), and start the health and metrics server.
  metrics.instrument('imports', imports);
  automationWorkers.forEach((w, i) =>
    metrics.instrument([QUEUES.tick, QUEUES.evaluate, QUEUES.deliver][i]!, w),
  );
  metaWorkers.forEach((w, i) =>
    metrics.instrument([META_QUEUES.events, META_QUEUES.health][i]!, w),
  );
  tiktokWorkers.forEach((w, i) =>
    metrics.instrument([TIKTOK_QUEUES.events, TIKTOK_QUEUES.maintenance][i]!, w),
  );
  metrics.instrument(TENANT_PURGE_QUEUE, purgeWorker);
  const health = await startHealthServer(env.WORKER_HEALTH_PORT, {
    redis: connection,
    db,
    lastHeartbeatAt: heartbeat.lastSuccessAt,
    registry: metrics.registry,
    metricsToken: env.METRICS_TOKEN,
  });
  console.log(
    `[worker] health server on :${env.WORKER_HEALTH_PORT} (/health/live, /health/ready, /metrics${env.METRICS_TOKEN ? '' : ' disabled: METRICS_TOKEN not set'})`,
  );

  const shutdown = async (signal: string) => {
    console.log(`[worker] ${signal} received, finishing the current job and shutting down`);
    heartbeat.stop();
    metrics.stop();
    health.close();
    clearInterval(sweep);
    clearInterval(purge);
    clearInterval(metaSweep);
    clearInterval(metaPurge);
    clearInterval(tiktokSweep);
    clearInterval(tiktokPurge);
    await purgeWorker.close();
    await purgeQueue.close();
    await Promise.all(metaWorkers.map((w) => w.close()));
    await Promise.all([metaEventsQueue, metaHealthQueue].map((q) => q.close()));
    await Promise.all(tiktokWorkers.map((w) => w.close()));
    await Promise.all([tiktokEventsQueue, tiktokMaintenanceQueue].map((q) => q.close()));
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
  logUnhandled('startup', err);
  process.exit(1);
});
