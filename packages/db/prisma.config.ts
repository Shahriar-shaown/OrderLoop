import { defineConfig } from 'prisma/config';

// Migrations run as the table owner (app_migrator); the application connects as app_user.
// The root .env is loaded by scripts/with-root-env.mjs before the Prisma CLI starts.
export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: { path: 'prisma/migrations' },
  datasource: { url: process.env.DATABASE_MIGRATION_URL ?? '' },
});
