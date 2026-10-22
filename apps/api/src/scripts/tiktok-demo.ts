// Development-only walk-through of the TikTok Shop channel without any TikTok account. For a seeded business (pnpm db:seed) it,
// in MOCK mode:
//   1. creates a mock shop (labelled mock, no sign-in, currency MYR),
//   2. injects an AWAITING_SHIPMENT order for a seeded product through the SAME ingestion pipeline a real webhook uses and shows
//      the reservation,
//   3. replays the same webhook three more times and shows that no second reservation appears,
//   4. moves the order to IN_TRANSIT (the stock ships, once) and cancels a second order (its stock is released),
//   5. sends an order with a SKU nobody mapped (it waits, nothing moves), then maps the SKU and shows the order resolve,
//   6. prints the stock ledger lines these orders made (reasons carry the TikTok order id and nothing about a buyer).
// Run: pnpm tiktok:demo [--email owner@demo.orderloop.test] [--sku DEMO-TEE-M] [--url http://localhost:4000]
// A signed POST (--url) needs TIKTOK_APP_KEY and TIKTOK_APP_SECRET (the same values in the running API's environment). Refuses to
// run in production, against a non-local database, or when TIKTOK_MODE=live.
import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { NestFactory } from '@nestjs/core';
import { postSignedTikTokWebhook, sampleOrderStatusEvent } from '@orderloop/automation';
import { receiveStock, resolveLocation } from '@orderloop/catalog';
import { loadDotEnv, loadServerEnv } from '@orderloop/contracts/server';
import { Database } from '@orderloop/db';
import { AppModule } from '../app.module.js';
import type { AuthContext } from '../common/endpoint.js';
import { TikTokConnectionsService } from '../tiktok/connections.service.js';
import { TikTokMockService } from '../tiktok/mock.service.js';
import { TikTokOrdersService } from '../tiktok/orders.service.js';
import { TikTokSkuLinksService } from '../tiktok/sku-links.service.js';

loadDotEnv();
const env = loadServerEnv();
const host = new URL(env.DATABASE_URL).hostname;
if (env.NODE_ENV === 'production' || !['localhost', '127.0.0.1', '::1', '[::1]'].includes(host)) {
  console.error(
    `Refusing to run: NODE_ENV=${env.NODE_ENV}, database host=${host}. The demo is for local development only.`,
  );
  process.exit(1);
}
if (env.TIKTOK_MODE !== 'mock') {
  console.error(
    'Refusing to run: TIKTOK_MODE=live. The demo uses the mock shop (set TIKTOK_MODE=mock).',
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
const connections = app.get(TikTokConnectionsService, { strict: false });
const mock = app.get(TikTokMockService, { strict: false });
const orders = app.get(TikTokOrdersService, { strict: false });
const links = app.get(TikTokSkuLinksService, { strict: false });

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
      where: { tenantId, archivedAt: null, sku: SKU },
      include: { product: { select: { name: true } } },
    }),
  );
  if (!variant) throw new Error(`No variant with SKU ${SKU}. Run pnpm db:seed first.`);
  // a second variant that nobody will map, to show an order waiting for a person
  const other = await db.withContext({ tenantId }, (tx) =>
    tx.productVariant.findFirst({
      where: { tenantId, archivedAt: null, sku: { not: SKU } },
      orderBy: { createdAt: 'asc' },
    }),
  );
  console.log(
    `Business ${tenantId}, acting as ${EMAIL} (${auth.role}). MOCK mode: nothing reaches TikTok, and nothing here is in BDT.\n`,
  );

  // enough stock that the demo does not depend on the seed
  await db.withContext({ tenantId, userId: auth.userId }, async (tx) => {
    const locationId = await resolveLocation(tx, tenantId);
    for (const v of [variant, other].filter((x): x is NonNullable<typeof x> => Boolean(x)))
      await receiveStock(tx, { tenantId, variantId: v.id, locationId }, 20, {
        createdById: auth.userId,
        reason: 'TikTok demo stock',
      });
  });
  const level = (variantId: string) =>
    db.withContext({ tenantId }, async (tx) => {
      const rows = await tx.stockLevel.findMany({ where: { tenantId, variantId } });
      const sum = (k: 'onHand' | 'reserved') => rows.reduce((n, r) => n + r[k], 0);
      return `on hand ${sum('onHand')}, reserved ${sum('reserved')}, available ${sum('onHand') - sum('reserved')}`;
    });
  console.log(`   ${variant.sku} before: ${await level(variant.id)}`);

  // 1. a mock shop
  const shop = await connections.createMockConnection(
    auth,
    { shopName: 'Demo TikTok shop (mock)', region: 'MY', currency: 'MYR' },
    null,
  );
  console.log(
    `1. Mock shop ${shop.id.slice(0, 8)}: ${shop.shopName} [mock=${shop.mock}, region=${shop.region}, currency=${shop.currency}]`,
  );

  // 2. an order awaiting shipment, through the real pipeline
  const orderId = `DEMO-${randomUUID().slice(0, 8)}`;
  const notificationId = `demo_n_${randomUUID()}`;
  const first = {
    connectionId: shop.id,
    externalOrderId: orderId,
    notificationId,
    status: 'AWAITING_SHIPMENT',
    onHold: false,
    items: [{ skuId: 'tt-sku-1', sellerSku: variant.sku, quantity: 3, unitPriceMinor: 2590 }],
  };
  const r1 = await mock.injectOrder(auth, first);
  console.log(
    `2. Order ${orderId}: status ${r1.status}, stock ${r1.stockState}. ${variant.sku} now: ${await level(variant.id)}`,
  );

  // 3. the same webhook, three more times
  for (let n = 1; n <= 3; n++) {
    const again = await mock.injectOrder(auth, first);
    console.log(
      `3.${n} Replayed the same notification: duplicate=${again.duplicate}. ${variant.sku}: ${await level(variant.id)}`,
    );
  }

  // 4. shipped once; another order cancelled
  const r2 = await mock.changeStatus(auth, r1.orderId!, { status: 'IN_TRANSIT' });
  console.log(`4. IN_TRANSIT: stock ${r2.stockState}. ${variant.sku}: ${await level(variant.id)}`);
  const r2b = await mock.changeStatus(auth, r1.orderId!, { status: 'IN_TRANSIT' });
  console.log(
    `   IN_TRANSIT again: stock ${r2b.stockState}. ${variant.sku}: ${await level(variant.id)}`,
  );
  const cancelId = `DEMO-${randomUUID().slice(0, 8)}`;
  const r3 = await mock.injectOrder(auth, {
    connectionId: shop.id,
    externalOrderId: cancelId,
    status: 'AWAITING_SHIPMENT',
    onHold: false,
    items: [{ skuId: 'tt-sku-1', sellerSku: variant.sku, quantity: 2, unitPriceMinor: 0 }],
  });
  console.log(`   Order ${cancelId} reserved 2: ${await level(variant.id)}`);
  const r3b = await mock.changeStatus(auth, r3.orderId!, { status: 'CANCELLED' });
  console.log(
    `   ...cancelled: stock ${r3b.stockState}. ${variant.sku}: ${await level(variant.id)}`,
  );

  // 5. an unmapped SKU waits, then is mapped
  if (other) {
    const waitingId = `DEMO-${randomUUID().slice(0, 8)}`;
    const r4 = await mock.injectOrder(auth, {
      connectionId: shop.id,
      externalOrderId: waitingId,
      status: 'AWAITING_SHIPMENT',
      onHold: false,
      items: [
        { skuId: 'tt-sku-1', sellerSku: variant.sku, quantity: 1, unitPriceMinor: 0 },
        { skuId: 'tt-sku-mystery', sellerSku: 'TT-UNKNOWN-CODE', quantity: 1, unitPriceMinor: 0 },
      ],
    });
    console.log(
      `5. Order ${waitingId} has a SKU nobody mapped: stock ${r4.stockState} (nothing moved, not even the mapped line). ${variant.sku}: ${await level(variant.id)}`,
    );
    const unmapped = (await links.list(auth, { unmapped: true, limit: 50 })).items.find(
      (l) => l.externalSkuId === 'tt-sku-mystery' && l.connectionId === shop.id,
    );
    if (!unmapped) throw new Error('The unmapped SKU link was not found.');
    const mapped = await links.update(auth, unmapped.id, { variantId: other.id }, null);
    const after = await orders.get(auth, r4.orderId!);
    console.log(
      `   A person maps it to ${other.sku}: ${mapped.reconciledOrders} waiting order(s) looked at again, stock ${after.stockState}. ${variant.sku}: ${await level(variant.id)}, ${other.sku}: ${await level(other.id)}`,
    );
  }

  // 6. a signed webhook to a running API
  if (URL_ARG) {
    const key = env.TIKTOK_APP_KEY;
    const secret = env.TIKTOK_APP_SECRET;
    if (!key || !secret)
      console.log('6. Skipped the signed webhook: TIKTOK_APP_KEY / TIKTOK_APP_SECRET are not set.');
    else {
      const url = `${URL_ARG.replace(/\/+$/, '')}/v1/webhooks/tiktok-shop`;
      const payload = sampleOrderStatusEvent({
        shopId: shop.shopId,
        orderId,
        status: 'DELIVERED',
        notificationId: `demo_signed_${randomUUID()}`,
      });
      for (let n = 1; n <= 2; n++) {
        const r = await postSignedTikTokWebhook(url, payload, key, secret);
        console.log(
          `6.${n} Signed POST to ${url}: ${r.status}, body ${JSON.stringify(r.body)} (TikTok wants an empty one)`,
        );
      }
    }
  }

  // 7. what the ledger says
  const ledger = await db.withContext({ tenantId }, (tx) =>
    tx.stockMovement.findMany({
      where: { tenantId, referenceType: 'tiktok_order' },
      orderBy: { seq: 'asc' },
      include: { variant: { select: { sku: true } } },
      take: 200,
    }),
  );
  const mine = ledger.filter((m) => m.reason?.includes('DEMO-'));
  console.log('\nStock ledger lines made by the TikTok demo orders (oldest first):');
  for (const m of mine)
    console.log(
      `   ${m.type.padEnd(8)} ${m.variant.sku.padEnd(14)} on hand ${String(m.onHandDelta).padStart(3)}  reserved ${String(m.reservedDelta).padStart(3)}  ${m.reason}`,
    );
  console.log(
    '\nEach order has at most one RESERVE and one SHIP or RELEASE per line, however often it was announced. The mirrored orders keep the',
  );
  console.log(
    "shop's own currency (MYR) and no buyer data; they never enter OrderLoop's own orders, finance or any BDT total.",
  );
} finally {
  await app.close();
}
