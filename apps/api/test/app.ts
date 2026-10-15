import 'reflect-metadata';
import type { INestApplication } from '@nestjs/common';
import { DiscoveryModule } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import { routes, type AuthResult, type RouteSpec } from '@orderloop/contracts';
import { Database } from '@orderloop/db';
import request from 'supertest';
import { AppModule } from '../src/app.module.js';
import { InviteSender, MemoryInviteSender } from '../src/members/invite-sender.js';

export interface TestApp {
  app: INestApplication;
  http: ReturnType<typeof request>;
  db: Database;
  invites: MemoryInviteSender;
  close(): Promise<void>;
}

export async function createTestApp(env: Record<string, string> = {}): Promise<TestApp> {
  const previous = Object.fromEntries(Object.keys(env).map((k) => [k, process.env[k]]));
  Object.assign(process.env, env);
  const invites = new MemoryInviteSender();
  const moduleRef = await Test.createTestingModule({ imports: [AppModule, DiscoveryModule] })
    .overrideProvider(InviteSender)
    .useValue(invites)
    .compile();
  const app = moduleRef.createNestApplication();
  await app.init();
  return {
    app,
    http: request(app.getHttpServer()),
    db: app.get(Database),
    invites,
    async close() {
      await app.close();
      for (const [k, v] of Object.entries(previous))
        v === undefined ? delete process.env[k] : (process.env[k] = v);
    },
  };
}

let counter = 0;
export const uniqueEmail = (prefix = 'user') => `${prefix}-${Date.now()}-${++counter}@example.test`;
export const PASSWORD = 'correct horse battery staple';

export async function registerTenant(
  t: TestApp,
  overrides: Partial<{ email: string; name: string; tenantName: string; password: string }> = {},
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
  return { email, ...(res.body as AuthResult & { refreshToken: string }) };
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
  const sent = t.invites.sent.findLast((m) => m.email === email)!;
  const accepted = await t.http
    .post('/v1/auth/accept-invitation')
    .send({ token: sent.token, name: `Member ${role}`, password: opts.password ?? PASSWORD });
  if (accepted.status !== 201)
    throw new Error(`accept failed: ${accepted.status} ${JSON.stringify(accepted.body)}`);
  return { email, ...(accepted.body as AuthResult & { refreshToken: string }) };
}

export type { RouteSpec };
export { routes };
