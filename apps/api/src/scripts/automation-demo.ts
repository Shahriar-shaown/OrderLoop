// Development-only walk-through of automation without any paid service. For a seeded business (pnpm db:seed) it:
//   1. switches on the LOW_STOCK rule (in-app + push; the dev push provider only logs),
//   2. takes one variant above its reorder point, then drops it below,
//   3. triggers the rule through the same AutomationService the API uses (POST /v1/automation/rules/LOW_STOCK/run),
//   4. delivers what was queued in-process (dev push, console email), prints the notifications and deliveries,
//   5. triggers again to show that nothing is created twice.
// Run: pnpm automation:demo [--email owner@demo.orderloop.test] [--sku DEMO-TEE-M]
// Refuses to run in production or against a non-local database, like the seed.
import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import {
  buildProviders,
  jsonLogger,
  processDelivery,
  type EmailSender,
} from '@orderloop/automation';
import { adjustStock, ensureDefaultLocation, readLevel } from '@orderloop/catalog';
import { loadDotEnv, loadServerEnv } from '@orderloop/contracts/server';
import { Database } from '@orderloop/db';
import { AppModule } from '../app.module.js';
import { AutomationService } from '../automation/automation.service.js';
import type { AuthContext } from '../common/endpoint.js';

loadDotEnv();
const env = loadServerEnv();
const host = new URL(env.DATABASE_URL).hostname;
if (env.NODE_ENV === 'production' || !['localhost', '127.0.0.1', '::1', '[::1]'].includes(host)) {
  console.error(
    `Refusing to run: NODE_ENV=${env.NODE_ENV}, database host=${host}. The demo is for local development only.`,
  );
  process.exit(1);
}

const arg = (name: string, fallback: string): string => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1]! : fallback;
};
const EMAIL = arg('email', 'owner@demo.orderloop.test');
const SKU = arg('sku', 'DEMO-TEE-M');

const app = await NestFactory.createApplicationContext(AppModule, { logger: ['error'] });
const db = app.get(Database);
const automation = app.get(AutomationService);

try {
  const user = await db.global.user.findUnique({ where: { email: EMAIL } });
  if (!user) throw new Error(`No user ${EMAIL}. Run pnpm db:seed first.`);
  const membership = await db.withContext({ userId: user.id }, (tx) =>
    tx.membership.findFirst({ where: { userId: user.id }, orderBy: { createdAt: 'asc' } }),
  );
  if (!membership) throw new Error(`${EMAIL} belongs to no business.`);
  const auth: AuthContext = {
    userId: user.id,
    tenantId: membership.tenantId,
    role: membership.role,
    sessionId: '00000000-0000-4000-8000-000000000000',
  };
  const tenantId = auth.tenantId;

  console.log(`Business ${tenantId}, acting as ${EMAIL} (${auth.role})\n`);

  // 1. the rule
  const rule = await automation.updateRule(
    auth,
    'LOW_STOCK',
    {
      enabled: true,
      config: { basis: 'reorder_point', includeZeroStock: true },
      channels: { inApp: true, push: true },
    },
    null,
  );
  console.log(
    `1. LOW_STOCK rule: enabled=${rule.enabled}, channels=${JSON.stringify(rule.channels)}`,
  );

  // a dev phone for the owner, so the push shows up in the dev outbox
  await db.withContext(
    { tenantId, userId: user.id },
    (tx) =>
      tx.$queryRaw`SELECT * FROM upsert_push_device(${user.id}::uuid, ${'DemoDevicePushToken-owner'}, 'android'::"PushPlatform", ${env.PUSH_PROVIDER}::"PushProviderKind")`,
  );

  // 2. a variant above its reorder point, then below it
  const variant =
    (await db.withContext({ tenantId, userId: user.id }, (tx) =>
      tx.productVariant.findFirst({ where: { tenantId, sku: SKU } }),
    )) ??
    (await db.withContext({ tenantId, userId: user.id }, (tx) =>
      tx.productVariant.findFirst({
        where: { tenantId, reorderPoint: { gt: 0 }, archivedAt: null },
        orderBy: { sku: 'asc' },
      }),
    ));
  if (!variant || variant.reorderPoint <= 0)
    throw new Error(`No variant with a reorder point to play with (sku ${SKU}).`);
  const adjust = (wanted: number) =>
    db.withContext({ tenantId, userId: user.id }, async (tx) => {
      const target = {
        tenantId,
        variantId: variant.id,
        locationId: await ensureDefaultLocation(tx, tenantId),
      };
      const level = await readLevel(tx, target);
      if (level.available !== wanted)
        await adjustStock(tx, target, wanted - level.available, {
          createdById: user.id,
          reason: 'automation demo',
        });
    });
  await adjust(variant.reorderPoint + 10);
  const first = await automation.runRule(auth, 'LOW_STOCK', {});
  console.log(
    `2. ${variant.sku} restored above its reorder point (${variant.reorderPoint}); run ${first.id.slice(0, 8)}: ${first.status}, ${first.createdCount} notification(s) for anything else that was already low`,
  );
  await adjust(Math.max(variant.reorderPoint - 1, 0));
  console.log(
    `   ${variant.sku} lowered to ${Math.max(variant.reorderPoint - 1, 0)} (reorder point ${variant.reorderPoint})`,
  );

  // 3. trigger through the same service
  const second = await automation.runRule(auth, 'LOW_STOCK', {});
  console.log(
    `3. run ${second.id.slice(0, 8)}: ${second.status}, notifications created: ${second.createdCount}, skipped: ${second.skippedCount}`,
  );

  // 4. deliver what was queued, in this process
  const email: EmailSender = {
    async send(m) {
      console.log(`   [email] subject="${m.subject}" (console provider: nothing is sent)`);
    },
  };
  const providers = buildProviders(
    {
      nodeEnv: env.NODE_ENV,
      pushProvider: env.PUSH_PROVIDER,
      pushDevOutbox: env.PUSH_DEV_OUTBOX,
      expoAccessToken: env.EXPO_ACCESS_TOKEN,
      smsProvider: env.SMS_PROVIDER,
      whatsappProvider: env.WHATSAPP_PROVIDER,
    },
    email,
    jsonLogger,
  );
  const pending = await db.withContext({ tenantId }, (tx) =>
    tx.notificationDelivery.findMany({
      where: { tenantId, status: 'pending' },
      select: { id: true },
    }),
  );
  for (const d of pending)
    await processDelivery(
      { db, providers, now: () => new Date(), log: () => undefined },
      { tenantId, deliveryId: d.id },
    );

  const show = async (label: string) => {
    const notifications = await db.withContext({ tenantId, userId: user.id }, (tx) =>
      tx.notification.findMany({
        where: { tenantId, kind: 'LOW_STOCK' },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: 200,
        include: { deliveries: { orderBy: { channel: 'asc' } } },
      }),
    );
    const people = await db.global.user.findMany({
      where: { id: { in: [...new Set(notifications.map((n) => n.userId))] } },
      select: { id: true, name: true },
    });
    const nameOf = new Map(people.map((p) => [p.id, p.name]));
    console.log(
      `\n${label}: ${notifications.length} low-stock notification(s) in this business so far; the newest:`,
    );
    for (const n of notifications.slice(0, 6))
      console.log(
        `  - to ${nameOf.get(n.userId) ?? '?'}: [${n.title}] ${n.body}\n      deliveries: ${n.deliveries.map((x) => `${x.channel}=${x.status}`).join(', ')}`,
      );
    return notifications.length;
  };
  const before = await show('4. after the run');

  // 5. again: nothing new
  const third = await automation.runRule(auth, 'LOW_STOCK', {});
  console.log(
    `\n5. run ${third.id.slice(0, 8)} again: ${third.status}, notifications created: ${third.createdCount}`,
  );
  const after = await show('   after the second run');
  console.log(
    after === before
      ? '\nNo duplicates: the same variant is announced once until its stock recovers.'
      : '\nUnexpected: the count changed.',
  );
  if (env.PUSH_DEV_OUTBOX) console.log(`Dev push outbox: ${env.PUSH_DEV_OUTBOX}`);
} finally {
  await app.close();
}
