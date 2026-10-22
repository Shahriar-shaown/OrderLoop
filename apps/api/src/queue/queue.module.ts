import { Global, Inject, Injectable, Module, OnApplicationShutdown } from '@nestjs/common';
import { META_QUEUES, QUEUES, TIKTOK_QUEUES } from '@orderloop/automation';
import { Queue } from 'bullmq';
import { APP_CONFIG, type AppConfig } from '../config/config.module.js';

export const IMPORTS_QUEUE = Symbol('IMPORTS_QUEUE');
/** Rule evaluations: new-order events and retries. The worker's scheduler puts the timed ones on the same queue. */
export const AUTOMATION_QUEUE = Symbol('AUTOMATION_QUEUE');
/** One job per (notification, channel). */
export const DELIVERY_QUEUE = Symbol('DELIVERY_QUEUE');
/** One job per stored Meta webhook event (ids only). */
export const META_EVENTS_QUEUE = Symbol('META_EVENTS_QUEUE');
/** One job per stored TikTok Shop webhook event (ids only). */
export const TIKTOK_EVENTS_QUEUE = Symbol('TIKTOK_EVENTS_QUEUE');
/** The job payload carries ids only. The CSV stays in the database, so Redis never holds customer data. */
export interface ImportJobData {
  tenantId: string;
  importId: string;
}

@Injectable()
class QueueLifecycle implements OnApplicationShutdown {
  constructor(
    @Inject(IMPORTS_QUEUE) private readonly imports: Queue<ImportJobData>,
    @Inject(AUTOMATION_QUEUE) private readonly automation: Queue,
    @Inject(DELIVERY_QUEUE) private readonly delivery: Queue,
    @Inject(META_EVENTS_QUEUE) private readonly metaEvents: Queue,
    @Inject(TIKTOK_EVENTS_QUEUE) private readonly tiktokEvents: Queue,
  ) {}
  async onApplicationShutdown(): Promise<void> {
    await Promise.all(
      [this.imports, this.automation, this.delivery, this.metaEvents, this.tiktokEvents].map((q) =>
        typeof q.close === 'function' ? q.close().catch(() => undefined) : undefined,
      ),
    );
  }
}

/**
 * Connection settings (not a connection): given options, BullMQ opens its own connections (it requires
 * maxRetriesPerRequest to be disabled) and closes them with the queue, so the process can exit cleanly.
 */
export function redisConnection(url: string) {
  const u = new URL(url);
  return {
    host: u.hostname,
    port: Number(u.port || 6379),
    ...(u.username ? { username: decodeURIComponent(u.username) } : {}),
    ...(u.password ? { password: decodeURIComponent(u.password) } : {}),
    db: u.pathname.length > 1 ? Number(u.pathname.slice(1)) : 0,
    ...(u.protocol === 'rediss:' ? { tls: {} } : {}),
    maxRetriesPerRequest: null,
  };
}
const connect = (config: AppConfig) => redisConnection(config.REDIS_URL);

@Global()
@Module({
  providers: [
    {
      provide: IMPORTS_QUEUE,
      inject: [APP_CONFIG],
      useFactory: (config: AppConfig) =>
        new Queue<ImportJobData>('imports', { connection: connect(config) }),
    },
    {
      provide: AUTOMATION_QUEUE,
      inject: [APP_CONFIG],
      useFactory: (config: AppConfig) =>
        new Queue(QUEUES.evaluate, { connection: connect(config) }),
    },
    {
      provide: DELIVERY_QUEUE,
      inject: [APP_CONFIG],
      useFactory: (config: AppConfig) => new Queue(QUEUES.deliver, { connection: connect(config) }),
    },
    {
      provide: META_EVENTS_QUEUE,
      inject: [APP_CONFIG],
      useFactory: (config: AppConfig) =>
        new Queue(META_QUEUES.events, { connection: connect(config) }),
    },
    {
      provide: TIKTOK_EVENTS_QUEUE,
      inject: [APP_CONFIG],
      useFactory: (config: AppConfig) =>
        new Queue(TIKTOK_QUEUES.events, { connection: connect(config) }),
    },
    QueueLifecycle,
  ],
  exports: [
    IMPORTS_QUEUE,
    AUTOMATION_QUEUE,
    DELIVERY_QUEUE,
    META_EVENTS_QUEUE,
    TIKTOK_EVENTS_QUEUE,
  ],
})
export class QueueModule {}
