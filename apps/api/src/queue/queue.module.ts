import { Global, Inject, Injectable, Module, OnApplicationShutdown } from '@nestjs/common';
import { Queue } from 'bullmq';
import { Redis } from 'ioredis';
import { APP_CONFIG, type AppConfig } from '../config/config.module.js';

export const IMPORTS_QUEUE = Symbol('IMPORTS_QUEUE');
/** The job payload carries ids only. The CSV stays in the database, so Redis never holds customer data. */
export interface ImportJobData {
  tenantId: string;
  importId: string;
}

@Injectable()
class QueueLifecycle implements OnApplicationShutdown {
  constructor(@Inject(IMPORTS_QUEUE) private readonly queue: Queue<ImportJobData>) {}
  async onApplicationShutdown(): Promise<void> {
    await this.queue.close();
  }
}

@Global()
@Module({
  providers: [
    {
      provide: IMPORTS_QUEUE,
      inject: [APP_CONFIG],
      // BullMQ requires its own connection with maxRetriesPerRequest disabled.
      useFactory: (config: AppConfig) =>
        new Queue<ImportJobData>('imports', {
          connection: new Redis(config.REDIS_URL, { maxRetriesPerRequest: null }),
        }),
    },
    QueueLifecycle,
  ],
  exports: [IMPORTS_QUEUE],
})
export class QueueModule {}
