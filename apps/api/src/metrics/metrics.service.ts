import { Inject, Injectable, Logger, OnApplicationShutdown } from '@nestjs/common';
import { META_QUEUES, QUEUES } from '@orderloop/automation';
import { Database } from '@orderloop/db';
import {
  BACKUP_LAST_SUCCESS_KEY,
  HEARTBEAT_KEY,
  Registry,
  createHttpMetrics,
  registerProcessMetrics,
  registerQueueMetrics,
} from '@orderloop/observability';
import { Queue } from 'bullmq';
import { Redis } from 'ioredis';
import { APP_CONFIG, type AppConfig } from '../config/config.module.js';
import { HealthService } from '../health/health.service.js';
import { REDIS } from '../redis/redis.module.js';

/** Every queue of the system, by its real name. */
export const METRIC_QUEUES = [
  'imports',
  QUEUES.tick,
  QUEUES.evaluate,
  QUEUES.deliver,
  META_QUEUES.events,
  META_QUEUES.health,
  // The worker's hourly purge of deleted businesses (apps/worker/src/tenant-purge.ts; the API cannot import the worker's constant).
  'tenant-purge',
] as const;

const ageSeconds = (iso: string | null, now: number): number | undefined => {
  if (!iso) return undefined;
  const t = Date.parse(iso);
  return Number.isNaN(t) ? undefined : Math.max(0, (now - t) / 1000);
};

/**
 * Prometheus metrics of the API: process, HTTP (by route template), dependency health, queue depth and age for every BullMQ
 * queue, the worker heartbeat age and the age of the last backup. Nothing here carries a user, a business, an email or an id.
 * The endpoint itself (GET /metrics, bearer-token protected, absent without METRICS_TOKEN) is mounted in main.ts.
 */
@Injectable()
export class MetricsService implements OnApplicationShutdown {
  private readonly logger = new Logger('Metrics');
  readonly registry = new Registry();
  readonly httpMiddleware = createHttpMetrics(this.registry);
  private readonly processHandle = registerProcessMetrics(this.registry, {
    service: 'orderloop-api',
  });
  private queueConnection: Redis | undefined;
  private queues: Queue[] = [];

  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(REDIS) private readonly redis: Redis,
    private readonly db: Database,
    private readonly health: HealthService,
  ) {
    if (!config.METRICS_TOKEN) return; // /metrics is off: nothing below is ever read
    this.registerDependencies();
    this.registerQueues();
    this.registerRedisTimestamps();
  }

  private registerDependencies(): void {
    const up = this.registry.gauge({
      name: 'orderloop_dependency_up',
      help: '1 when the dependency answered the readiness probe, else 0',
      labelNames: ['dependency'],
    });
    up.setCollector(async (g) => {
      const { checks } = await this.health.check();
      for (const [dependency, status] of Object.entries(checks))
        g.set({ dependency }, status === 'up' ? 1 : 0);
    });
    const ping = this.registry.gauge({
      name: 'orderloop_db_ping_seconds',
      help: 'Time for SELECT 1 through the API connection pool (grows when the pool is exhausted or the database is slow); absent when it fails',
    });
    ping.setCollector(async (g) => {
      const started = process.hrtime.bigint();
      await Promise.race([
        this.db.ping(),
        new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 3000)),
      ]);
      g.set({}, Number(process.hrtime.bigint() - started) / 1e9);
    });
  }

  private registerQueues(): void {
    // BullMQ queues need a connection without a per-command retry limit; one shared connection serves the read-only stats.
    this.queueConnection = new Redis(this.config.REDIS_URL, { maxRetriesPerRequest: null });
    this.queueConnection.on('error', () => undefined); // the queue collectors time out and omit their series instead
    this.queues = METRIC_QUEUES.map(
      (name) => new Queue(name, { connection: this.queueConnection as Redis }),
    );
    registerQueueMetrics(this.registry, Object.fromEntries(this.queues.map((q) => [q.name, q])));
  }

  private registerRedisTimestamps(): void {
    const heartbeatAge = this.registry.gauge({
      name: 'orderloop_worker_heartbeat_age_seconds',
      help: 'Seconds since the last worker heartbeat; absent when the key has expired (no worker alive) or Redis is unreachable',
    });
    heartbeatAge.setCollector(async (g) => {
      const age = ageSeconds(await this.redis.get(HEARTBEAT_KEY), Date.now());
      if (age !== undefined) g.set({}, age);
    });
    const heartbeatPresent = this.registry.gauge({
      name: 'orderloop_worker_heartbeat_present',
      help: '1 when a worker heartbeat key exists in Redis, 0 when it expired; absent when Redis is unreachable',
    });
    heartbeatPresent.setCollector(async (g) => {
      g.set({}, (await this.redis.exists(HEARTBEAT_KEY)) ? 1 : 0);
    });
    const backup = this.registry.gauge({
      name: 'orderloop_backup_last_success_timestamp_seconds',
      help: 'Unix time of the last successful backup reported by ops/backup.sh through Redis; absent when never reported',
    });
    backup.setCollector(async (g) => {
      const iso = await this.redis.get(BACKUP_LAST_SUCCESS_KEY);
      const t = iso ? Date.parse(iso) : Number.NaN;
      if (!Number.isNaN(t)) g.set({}, t / 1000);
    });
  }

  async onApplicationShutdown(): Promise<void> {
    this.processHandle.stop();
    await Promise.all(this.queues.map((q) => q.close().catch(() => undefined)));
    this.queueConnection?.disconnect();
  }

  /** Test seam and logging only. */
  warn(message: string): void {
    this.logger.warn(message);
  }
}
