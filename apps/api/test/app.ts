import 'reflect-metadata';
import type { INestApplication } from '@nestjs/common';
import { DiscoveryModule } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import { routes, type AuthResult, type RouteSpec } from '@orderloop/contracts';
import { Database } from '@orderloop/db';
import type { Writable } from 'node:stream';
import request from 'supertest';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { AppModule } from '../src/app.module.js';
import { configureApp } from '../src/app.setup.js';
import { createLogger } from '../src/logging/logger.js';
import { LOGGER } from '../src/logging/tokens.js';
import { IMPORTS_QUEUE } from '../src/queue/queue.module.js';
import { PinoLoggerService } from '../src/logging/pino-logger.service.js';
import { Mailer } from '../src/mail/mailer.js';
import { MemoryMailer } from '../src/mail/memory.mailer.js';

export interface TestApp {
  app: NestExpressApplication;
  http: ReturnType<typeof request>;
  db: Database;
  /** Every email the API "sent" (in memory), with helpers to pull out the one-time tokens. */
  mail: MemoryMailer;
  close(): Promise<void>;
}

export async function createTestApp(
  env: Record<string, string> = {},
  options: { logDestination?: Writable; queue?: object } = {},
): Promise<TestApp> {
  const previous = Object.fromEntries(Object.keys(env).map((k) => [k, process.env[k]]));
  Object.assign(process.env, env);
  const mail = new MemoryMailer();
  let builder = Test.createTestingModule({ imports: [AppModule, DiscoveryModule] })
    .overrideProvider(Mailer)
    .useValue(mail);
  const logger = options.logDestination
    ? createLogger({ level: 'debug', destination: options.logDestination })
    : undefined;
  if (logger) builder = builder.overrideProvider(LOGGER).useValue(logger);
  if (options.queue) builder = builder.overrideProvider(IMPORTS_QUEUE).useValue(options.queue);
  const moduleRef = await builder.compile();
  const app = moduleRef.createNestApplication<NestExpressApplication>({ bodyParser: false });
  configureApp(app);
  // Same wiring as main.ts, so tests can assert on what would really be logged.
  if (logger) app.useLogger(new PinoLoggerService(logger));
  await app.init();
  return {
    app,
    http: request(app.getHttpServer()),
    db: app.get(Database),
    mail,
    async close() {
      await app.close();
      for (const [k, v] of Object.entries(previous))
        v === undefined ? delete process.env[k] : (process.env[k] = v);
    },
  };
}

let counter = 0;
export const uniqueEmail = (prefix = 'user') => `${prefix}-${Date.now()}-${++counter}@example.test`;
export const PASSWORD = 'Correct-horse-battery-7';

export async function registerTenant(
  t: TestApp,
  overrides: Partial<{
    email: string;
    name: string;
    tenantName: string;
    password: string;
    /** Complete email verification as part of registering (default). Pass false to test the unverified state. */
    verify: boolean;
  }> = {},
) {
  const email = overrides.email ?? uniqueEmail('owner');
  const res = await t.http.post('/v1/auth/register').send({
    email,
    password: overrides.password ?? PASSWORD,
    name: overrides.name ?? 'Test Owner',
    tenantName: overrides.tenantName ?? 'Test Shop',
  });
  if (res.status !== 201)
    throw new Error(`register failed: ${res.status} ${JSON.stringify(res.body)}`);
  const body = res.body as AuthResult & { refreshToken: string };
  if (overrides.verify !== false) {
    await t.http
      .post('/v1/auth/verify-email')
      .send({ token: t.mail.tokenFor(email, 'verify_email') })
      .expect(200);
    body.user.emailVerified = true;
  }
  return { email, ...body };
}

export const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });

/** Invite `email` into the caller's tenant and accept it, returning the new member's session. */
export async function addMember(
  t: TestApp,
  inviter: { accessToken: string },
  role: 'ADMIN' | 'MANAGER' | 'STAFF' | 'ACCOUNTANT' | 'OWNER',
  opts: { email?: string; password?: string } = {},
) {
  const email = opts.email ?? uniqueEmail(role.toLowerCase());
  const invite = await t.http
    .post('/v1/members/invitations')
    .set(bearer(inviter.accessToken))
    .send({ email, role });
  if (invite.status !== 201)
    throw new Error(`invite failed: ${invite.status} ${JSON.stringify(invite.body)}`);
  const token = t.mail.tokenFor(email, 'invitation');
  const accepted = await t.http
    .post('/v1/auth/accept-invitation')
    .send({ token, name: `Member ${role}`, password: opts.password ?? PASSWORD });
  if (accepted.status !== 201)
    throw new Error(`accept failed: ${accepted.status} ${JSON.stringify(accepted.body)}`);
  return { email, ...(accepted.body as AuthResult & { refreshToken: string }) };
}

export type { RouteSpec };
export { routes };

/** A product with one variant, created through the API. Returns the product and its first variant. */
export async function createProduct(
  t: TestApp,
  token: string,
  overrides: Partial<{
    name: string;
    sku: string;
    priceMinor: number;
    reorderPoint: number;
    unit: string;
    categoryId: string;
  }> = {},
) {
  const sku = overrides.sku ?? `SKU-${Date.now()}-${++counter}`;
  const res = await t.http
    .post('/v1/products')
    .set(bearer(token))
    .send({
      name: overrides.name ?? `Product ${sku}`,
      unit: overrides.unit ?? 'pcs',
      ...(overrides.categoryId ? { categoryId: overrides.categoryId } : {}),
      variants: [
        {
          sku,
          priceMinor: overrides.priceMinor ?? 125_000,
          reorderPoint: overrides.reorderPoint ?? 0,
        },
      ],
    });
  if (res.status !== 201)
    throw new Error(`createProduct failed: ${res.status} ${JSON.stringify(res.body)}`);
  const product = res.body as { id: string; variants: { id: string; sku: string }[] };
  return { product, variant: product.variants[0]! };
}
