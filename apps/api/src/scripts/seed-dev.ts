// Development-only seed data: one fictional workspace with three fictional people, so the API and the apps have
// something to sign in to. Contains no real personal information (names are invented, emails use the reserved
// `.test` TLD, which can never be delivered). Refuses to run in production or against a non-local database, with no override.
// Run: pnpm db:seed   (idempotent)
import { loadDotEnv, loadServerEnv } from '@orderloop/contracts/server';
import { Database } from '@orderloop/db';
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

try {
  const existingOwner = await db.global.user.findUnique({ where: { email: PEOPLE[0].email } });
  if (existingOwner) {
    console.log('Seed data already present; nothing to do.');
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
    console.log(`Created "${TENANT_NAME}". Sign in with any of these (password: ${PASSWORD}):`);
    for (const p of PEOPLE) console.log(`  ${p.role.padEnd(6)} ${p.email}`);
  }
} finally {
  await db.disconnect();
}
