import { Global, Injectable, Module, OnApplicationShutdown } from '@nestjs/common';
import { Database } from '@orderloop/db';
import { APP_CONFIG, type AppConfig } from '../config/config.module.js';

@Injectable()
class DatabaseLifecycle implements OnApplicationShutdown {
  constructor(private readonly db: Database) {}
  async onApplicationShutdown(): Promise<void> {
    await this.db.disconnect();
  }
}

@Global()
@Module({
  providers: [
    {
      provide: Database,
      inject: [APP_CONFIG],
      useFactory: (config: AppConfig) => new Database(config.DATABASE_URL),
    },
    DatabaseLifecycle,
  ],
  exports: [Database],
})
export class DatabaseModule {}
