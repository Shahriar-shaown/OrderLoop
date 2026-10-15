import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { loadDotEnv, loadServerEnv } from '@orderloop/contracts/server';
import { AppModule } from './app.module.js';

async function bootstrap() {
  loadDotEnv();
  const env = loadServerEnv();
  const app = await NestFactory.create(AppModule);
  app.enableShutdownHooks();
  await app.listen(env.API_PORT);
}

void bootstrap();
