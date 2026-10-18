import { Module, RequestMethod, type MiddlewareConsumer, type NestModule } from '@nestjs/common';
import { APP_FILTER, APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { AccessGuard } from './auth/access.guard.js';
import { AuthModule } from './auth/auth.module.js';
import { AuditModule } from './audit/audit.module.js';
import { CatalogModule } from './catalog/catalog.module.js';
import { OrdersModule } from './orders/orders.module.js';
import { FinanceModule } from './finance/finance.module.js';
import { CouriersModule } from './couriers/couriers.module.js';
import { DashboardModule } from './dashboard/dashboard.module.js';
import { ExportsModule } from './exports/exports.module.js';
import { ImportsModule } from './imports/imports.module.js';
import { InventoryModule } from './inventory/inventory.module.js';
import { QueueModule } from './queue/queue.module.js';
import { ProblemFilter } from './common/problem.filter.js';
import { ValidationInterceptor } from './common/validation.interceptor.js';
import { APP_CONFIG, ConfigModule, type AppConfig } from './config/config.module.js';
import { DatabaseModule } from './db/database.module.js';
import { HealthModule } from './health/health.module.js';
import { LoggingModule } from './logging/logging.module.js';
import { RequestLogMiddleware } from './logging/request-log.middleware.js';
import { MailModule } from './mail/mail.module.js';
import { MembersModule } from './members/members.module.js';
import { OpenApiController } from './openapi.controller.js';
import { WorkspacesModule } from './workspaces/workspaces.module.js';
import { RedisModule } from './redis/redis.module.js';

@Module({
  imports: [
    ConfigModule,
    LoggingModule,
    MailModule,
    DatabaseModule,
    RedisModule,
    QueueModule,
    // Per-IP budget for everything; credential endpoints tighten it with @Throttle. In-memory per instance:
    // switch to a shared store before running more than one API replica.
    ThrottlerModule.forRootAsync({
      inject: [APP_CONFIG],
      useFactory: (config: AppConfig) => ({
        throttlers: [{ ttl: 60_000, limit: 120 }],
        skipIf: () => !config.RATE_LIMIT_ENABLED,
      }),
    }),
    HealthModule,
    AuthModule,
    AuditModule,
    MembersModule,
    WorkspacesModule,
    CatalogModule,
    InventoryModule,
    ImportsModule,
    ExportsModule,
    OrdersModule,
    CouriersModule,
    FinanceModule,
    DashboardModule,
  ],
  controllers: [OpenApiController],
  providers: [
    { provide: APP_GUARD, useClass: ThrottlerGuard },
    { provide: APP_GUARD, useExisting: AccessGuard },
    { provide: APP_INTERCEPTOR, useClass: ValidationInterceptor },
    { provide: APP_FILTER, useClass: ProblemFilter },
  ],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(RequestLogMiddleware).forRoutes({ path: '{*path}', method: RequestMethod.ALL });
  }
}
