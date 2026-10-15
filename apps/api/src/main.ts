import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { loadDotEnv, loadServerEnv } from '@orderloop/contracts/server';
import helmet from 'helmet';
import { AppModule } from './app.module.js';
import { APP_CONFIG, type AppConfig } from './config/config.module.js';

async function bootstrap() {
  loadDotEnv();
  loadServerEnv(); // fail fast with every invalid variable listed
  const app = await NestFactory.create(AppModule);
  const config = app.get<AppConfig>(APP_CONFIG);
  // Only trust X-Forwarded-For for the exact number of proxies in front of us; trusting it blindly lets clients spoof their IP.
  if (config.TRUST_PROXY > 0)
    app.getHttpAdapter().getInstance().set('trust proxy', config.TRUST_PROXY);
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
