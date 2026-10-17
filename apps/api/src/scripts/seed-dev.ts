// Development-only seed data: one fictional workspace with three fictional people, so the API and the apps have
// something to sign in to. Contains no real personal information (names are invented, emails use the reserved
// `.test` TLD, which can never be delivered). Refuses to run in production or against a non-local database, with no override.
// Run: pnpm db:seed   (idempotent)
import { loadDotEnv, loadServerEnv } from '@orderloop/contracts/server';
import { ensureDefaultLocation, receiveStock } from '@orderloop/catalog';
import { Database } from '@orderloop/db';
import { nameKey } from '@orderloop/domain';
import { uuidv7 } from '../common/uuid.js';
import { PasswordService } from '../auth/password.service.js';

loadDotEnv();
const env = loadServerEnv();

const host = new URL(env.DATABASE_URL).hostname;
const local = ['localhost', '127.0.0.1', '::1', '[::1]'].includes(host);
if (env.NODE_ENV === 'production' || !local) {
  console.error(
    `Refusing to seed: NODE_ENV=${env.NODE_ENV}, database host=${host}. Seed data is for local development only.`,
  );
  process.exit(1);
}

/** A fixed, documented, throwaway dev password. Override with SEED_PASSWORD. Never used outside local development. */
const PASSWORD = process.env.SEED_PASSWORD ?? 'demo-password-change-me';
const PEOPLE = [
  { email: 'owner@demo.orderloop.test', name: 'Demo Owner', role: 'OWNER' },
  { email: 'admin@demo.orderloop.test', name: 'Demo Admin', role: 'ADMIN' },
  { email: 'staff@demo.orderloop.test', name: 'Demo Staff', role: 'STAFF' },
] as const;
const TENANT_NAME = 'Demo Shop (seed data)';

const db = new Database(env.DATABASE_URL, { max: 2 });
const passwords = new PasswordService();

/** A tiny fictional catalog with opening stock, so the stock screens and low-stock alerts have something to show. */
async function seedCatalog(tenantId: string, ownerId: string): Promise<boolean> {
  return db.withContext({ tenantId, userId: ownerId }, async (tx) => {
    if ((await tx.product.count({ where: { tenantId } })) > 0) return false;
    const locationId = await ensureDefaultLocation(tx, tenantId);
    const categories = new Map<string, string>();
    for (const name of ['Apparel', 'Grocery', 'Homeware']) {
      categories.set(
        name,
        (await tx.category.create({ data: { tenantId, name, nameKey: nameKey(name) } })).id,
      );
    }
    const products = [
      {
        name: 'Demo Cotton T-Shirt',
        category: 'Apparel',
        unit: 'pcs',
        variants: [
          {
            sku: 'DEMO-TEE-M',
            name: 'Red / M',
            price: 125_000,
            cost: 80_000,
            reorder: 5,
            stock: 20,
          },
          {
            sku: 'DEMO-TEE-L',
            name: 'Red / L',
            price: 125_000,
            cost: 80_000,
            reorder: 5,
            stock: 3,
          }, // already low
        ],
      },
      {
        name: 'Demo Basmati Rice',
        category: 'Grocery',
        unit: 'kg',
        variants: [
          {
            sku: 'DEMO-RICE-5',
            name: '5 kg bag',
            price: 65_000,
            cost: 52_000,
            reorder: 10,
            stock: 40,
          },
        ],
      },
      {
        name: 'Demo Ceramic Mug',
        category: 'Homeware',
        unit: 'pcs',
        variants: [
          { sku: 'DEMO-MUG', name: '', price: 30_000, cost: 12_000, reorder: 0, stock: 0 },
        ],
      },
    ];
    for (const p of products) {
      const product = await tx.product.create({
        data: {
          tenantId,
          name: p.name,
          nameKey: nameKey(p.name),
          categoryId: categories.get(p.category)!,
          unit: p.unit,
        },
      });
      for (const v of p.variants) {
        const variant = await tx.productVariant.create({
          data: {
            tenantId,
            productId: product.id,
            sku: v.sku,
            name: v.name,
            priceMinor: v.price,
            costMinor: v.cost,
            reorderPoint: v.reorder,
          },
        });
        if (v.stock > 0)
          await receiveStock(tx, { tenantId, variantId: variant.id, locationId }, v.stock, {
            createdById: ownerId,
            reason: 'Opening stock (seed data)',
          });
      }
    }
    return true;
  });
}

try {
  const existingOwner = await db.global.user.findUnique({ where: { email: PEOPLE[0].email } });
  if (existingOwner) {
    const membership = await db.withContext({ userId: existingOwner.id }, (tx) =>
      tx.membership.findFirst({
        where: { userId: existingOwner.id },
        orderBy: { createdAt: 'asc' },
      }),
    );
    const added = membership ? await seedCatalog(membership.tenantId, existingOwner.id) : false;
    console.log(
      added
        ? 'Seed workspace already present; added the demo catalog.'
        : 'Seed data already present; nothing to do.',
    );
  } else {
    const passwordHash = await passwords.hash(PASSWORD);
    const tenantId = uuidv7();
    const users = PEOPLE.map((p) => ({ ...p, id: uuidv7() }));
    await db.withContext({ tenantId, userId: users[0]!.id }, async (tx) => {
      for (const u of users) {
        await tx.user.create({
          data: {
            id: u.id,
            email: u.email,
            name: u.name,
            passwordHash,
            emailVerifiedAt: new Date(),
          },
        });
      }
      await tx.tenant.create({ data: { id: tenantId, name: TENANT_NAME } });
      for (const u of users)
        await tx.membership.create({ data: { tenantId, userId: u.id, role: u.role } });
      await tx.auditLog.createMany({
        data: [
          {
            tenantId,
            actorUserId: users[0]!.id,
            action: 'seed.created',
            targetType: 'tenant',
            targetId: tenantId,
          },
        ],
      });
    });
    await seedCatalog(tenantId, users[0]!.id);
    console.log(
      `Created "${TENANT_NAME}" with a demo catalog. Sign in with any of these (password: ${PASSWORD}):`,
    );
    for (const p of PEOPLE) console.log(`  ${p.role.padEnd(6)} ${p.email}`);
  }
} finally {
  await db.disconnect();
}
