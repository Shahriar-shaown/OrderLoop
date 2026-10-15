import { Global, Module } from '@nestjs/common';
import { APP_CONFIG, type AppConfig } from '../config/config.module.js';
import { createLogger, type Logger } from './logger.js';
import { PinoLoggerService } from './pino-logger.service.js';
import { RequestLogMiddleware } from './request-log.middleware.js';
import { LOGGER } from './tokens.js';

@Global()
@Module({
  providers: [
    {
      provide: LOGGER,
      inject: [APP_CONFIG],
      useFactory: (config: AppConfig): Logger => createLogger({ level: config.LOG_LEVEL }),
    },
    {
      provide: PinoLoggerService,
      inject: [LOGGER],
      useFactory: (logger: Logger) => new PinoLoggerService(logger),
    },
    RequestLogMiddleware,
  ],
  exports: [LOGGER, PinoLoggerService],
})
export class LoggingModule {}
