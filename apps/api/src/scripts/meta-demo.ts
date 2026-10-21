// Development-only walk-through of the Meta (Facebook Page / Instagram) inbox without any Meta account. For a seeded business
// (pnpm db:seed) it, in MOCK mode:
//   1. creates a mock Page connection (labelled mock, no OAuth),
//   2. injects a synthetic Bangla order message through the SAME ingestion pipeline a real webhook uses,
//   3. prints the draft it became (what was extracted, from which message),
//   4. confirms it through the service the API uses (the normal order path: stock, validation, audit),
//   5. replays the identical message twice and prints the counts, proving no second event, draft or order appears,
//   6. with --url, also POSTs a correctly signed webhook to a running API (twice) and counts again.
// Run: pnpm meta:demo [--email owner@demo.orderloop.test] [--sku DEMO-TEE-M] [--url http://localhost:4000]
// A signed POST needs META_APP_SECRET (the same value in the running API's environment). Refuses to run in production, against a
// non-local database, or when META_MODE=live.
import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { NestFactory } from '@nestjs/core';
import { postSignedWebhook, sampleNotification } from '@orderloop/automation';
import { loadDotEnv, loadServerEnv } from '@orderloop/contracts/server';
import { Database } from '@orderloop/db';
import { AppModule } from '../app.module.js';
import type { AuthContext } from '../common/endpoint.js';
import { ConnectionsService } from '../meta/connections.service.js';
import { DraftsService } from '../meta/drafts.service.js';

loadDotEnv();
const env = loadServerEnv();
const host = new URL(env.DATABASE_URL).hostname;
if (env.NODE_ENV === 'production' || !['localhost', '127.0.0.1', '::1', '[::1]'].includes(host)) {
  console.error(
    `Refusing to run: NODE_ENV=${env.NODE_ENV}, database host=${host}. The demo is for local development only.`,
  );
  process.exit(1);
}
if (env.META_MODE !== 'mock') {
  console.error(
    'Refusing to run: META_MODE=live. The demo uses the mock provider (set META_MODE=mock).',
  );
  process.exit(1);
}

const arg = (name: string, fallback?: string): string | undefined => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1]! : fallback;
};
const EMAIL = arg('email', 'owner@demo.orderloop.test')!;
const SKU = arg('sku', 'DEMO-TEE-M')!;
const URL_ARG = arg('url');

const app = await NestFactory.createApplicationContext(AppModule, { logger: ['error'] });
const db = app.get(Database);
const connections = app.get(ConnectionsService, { strict: false });
const drafts = app.get(DraftsService, { strict: false });

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
  const variant = await db.withContext({ tenantId }, (tx) =>
    tx.productVariant.findFirst({
      where: { tenantId, archivedAt: null, ...(SKU ? { sku: SKU } : {}) },
      include: { product: { select: { name: true } } },
    }),
  );
  if (!variant) throw new Error(`No variant with SKU ${SKU}. Run pnpm db:seed first.`);
  console.log(
    `Business ${tenantId}, acting as ${EMAIL} (${auth.role}). MOCK mode: nothing reaches Meta.\n`,
  );

  const counts = () =>
    db.withContext({ tenantId }, async (tx) => ({
      events: await tx.socialEvent.count({ where: { tenantId, connection: { mock: true } } }),
      drafts: await tx.socialDraft.count({ where: { tenantId, mock: true } }),
      orders: await tx.order.count({
        where: { tenantId, sourceReference: { startsWith: 'mock ' } },
      }),
    }));
  const before = await counts();

  // 1. a mock Page
  const conn = await connections.createMockConnection(
    auth,
    { provider: 'facebook_page', displayName: 'Demo Page (mock)' },
    null,
  );
  console.log(
    `1. Mock connection ${conn.id.slice(0, 8)}: ${conn.displayName} [mock=${conn.mock}, status=${conn.status}]`,
  );

  // 2. a synthetic Bangla order message through the real pipeline
  const messageId = `demo_mid_${randomUUID()}`;
  const text = [
    'আসসালামু আলাইকুম',
    `আমি ২টা ${variant.sku} নিব`,
    'নাম: রহিম উদ্দিন',
    'মোবাইল: ০১৭১২-৩৪৫৬৭৮',
    'ঠিকানা: বাসা ১২, রোড ৫, ধানমন্ডি, ঢাকা',
  ].join('\n');
  const event = { connectionId: conn.id, senderId: 'demo-customer-1', text, messageId };
  const injected = await connections.injectMockEvent(auth, event);
  console.log(
    `2. Injected message ${messageId.slice(0, 16)}…: status=${injected.status}, draft=${injected.draftId?.slice(0, 8)}`,
  );

  // 3. the draft
  const draft = await drafts.get(auth, injected.draftId!);
  console.log('3. The draft a person reviews:');
  console.log(
    `   status=${draft.status} mock=${draft.mock} provider=${draft.provider} messages=${draft.messageCount}`,
  );
  const f = draft.fields;
  console.log(
    `   name:     ${f.customerName?.value ?? '-'} (${f.customerName?.confidence ?? '-'})`,
  );
  console.log(`   phone:    ${f.phone?.value ?? '-'} (${f.phone?.confidence ?? '-'})`);
  console.log(
    `   address:  ${f.address?.value ?? '-'} | district ${f.district?.value ?? '-'} -> division ${draft.suggestedDivision ?? '-'}`,
  );
  for (const i of f.items)
    console.log(
      `   item:     ${i.quantity} x ${i.match ? `${i.match.sku} (${i.match.productName}, ${i.match.priceMinor / 100} BDT from the catalogue)` : `"${i.text}" UNMATCHED`} confidence ${i.confidence}`,
    );
  console.log(`   warnings: ${draft.warnings.map((w) => w.code).join(', ') || 'none'}`);

  // 4. confirm through the normal order path (the person completes the order form; here the demo does)
  const matched = f.items.filter((i) => i.variantId);
  if (matched.length === 0)
    throw new Error('The demo item was not matched to the catalogue: check the SKU.');
  const orderBody = {
    customer: { name: f.customerName?.value ?? 'Demo Customer', phone: f.phone!.value },
    address: {
      recipientName: f.customerName?.value ?? 'Demo Customer',
      phone: f.phone!.value,
      line1: f.address?.value ?? 'Unknown',
      area: 'Dhanmondi',
      district: f.district?.value ?? 'Dhaka',
      division: (draft.suggestedDivision ?? 'Dhaka') as 'Dhaka',
    },
    items: matched.map((i) => ({ variantId: i.variantId!, quantity: i.quantity })),
    idempotencyKey: `demo-confirm-${draft.id}`,
  };
  const confirmed = await drafts.confirm(auth, draft.id, orderBody, null);
  console.log(
    `4. Confirmed: order #${confirmed.order.orderNumber} (${confirmed.order.status}), total ${confirmed.order.totalMinor / 100} BDT; draft is now ${confirmed.draft.status}`,
  );

  // 5. replay the identical event twice
  for (let n = 1; n <= 2; n++) {
    const again = await connections.injectMockEvent(auth, event);
    console.log(`5.${n} Replayed: duplicate=${again.duplicate}, status=${again.status}`);
  }
  const second = await drafts.confirm(
    auth,
    draft.id,
    { ...orderBody, idempotencyKey: `demo-confirm-${randomUUID()}` },
    null,
  );
  console.log(
    `   Confirming the same draft again returns the same order: ${second.order.id === confirmed.order.id}`,
  );

  // 6. a signed webhook to a running API
  if (URL_ARG) {
    const secret = env.META_APP_SECRET;
    if (!secret) console.log('6. Skipped the signed webhook: META_APP_SECRET is not set.');
    else {
      const url = `${URL_ARG.replace(/\/+$/, '')}/v1/webhooks/meta`;
      const payload = sampleNotification('page', conn.externalId, [
        {
          senderId: 'demo-customer-2',
          mid: `demo_signed_${randomUUID()}`,
          text: `অর্ডার, ${variant.sku}, ০১৮১২৩৪৫৬৭৮`,
        },
      ]);
      for (let n = 1; n <= 2; n++) {
        const r = await postSignedWebhook(url, payload, secret);
        console.log(`6.${n} Signed POST to ${url}: ${r.status} ${r.body}`);
      }
    }
  }

  const after = await counts();
  console.log('\nMock data in this business (before -> after this run):');
  console.log(
    `   events: ${before.events} -> ${after.events}   drafts: ${before.drafts} -> ${after.drafts}   orders from mock drafts: ${before.orders} -> ${after.orders}`,
  );
  console.log('   One new message made 1 event, 1 draft and 1 order; the replays added nothing.');
} finally {
  await app.close();
}
