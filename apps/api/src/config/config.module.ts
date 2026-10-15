import { Global, Module } from '@nestjs/common';
import { loadServerEnv, type ServerEnv } from '@orderloop/contracts/server';

export const APP_CONFIG = Symbol('APP_CONFIG');
export type AppConfig = ServerEnv;

@Global()
@Module({
  providers: [{ provide: APP_CONFIG, useFactory: (): AppConfig => loadServerEnv() }],
  exports: [APP_CONFIG],
})
export class ConfigModule {}
