import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { loadDotEnv, loadServerEnv } from '@orderloop/contracts/server';
import helmet from 'helmet';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { AppModule } from './app.module.js';
import { configureApp } from './app.setup.js';
import { mountApiDocs } from './docs.js';
import { PinoLoggerService } from './logging/pino-logger.service.js';
import { APP_CONFIG, type AppConfig } from './config/config.module.js';

async function bootstrap() {
  loadDotEnv();
  loadServerEnv(); // fail fast with every invalid variable listed
  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    bufferLogs: true,
    bodyParser: false, // configureApp sets the parsers
  });
  configureApp(app);
  // Every log line, including Nest's own, goes through the structured redacting logger.
  app.useLogger(app.get(PinoLoggerService));
  const config = app.get<AppConfig>(APP_CONFIG);
  // Only trust X-Forwarded-For for the exact number of proxies in front of us; trusting it blindly lets clients spoof their IP.
  if (config.TRUST_PROXY > 0)
    app.getHttpAdapter().getInstance().set('trust proxy', config.TRUST_PROXY);
  if (config.NODE_ENV !== 'production') mountApiDocs(app); // before helmet: the playground needs inline scripts
  app.use(helmet());
  app.enableCors({
    origin: config.WEB_ORIGINS,
    credentials: true,
    methods: ['GET', 'POST', 'PATCH', 'DELETE'],
    allowedHeaders: ['authorization', 'content-type', 'x-client'],
  });
  app.enableShutdownHooks();
  await app.listen(config.API_PORT);
}

void bootstrap();
