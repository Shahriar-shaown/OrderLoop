-- Business profile (name, logo, contact, address, currency, timezone, language) and a per-user language preference.

-- CreateEnum
CREATE TYPE "Language" AS ENUM ('en', 'bn');

-- AlterTable
ALTER TABLE "users" ADD COLUMN "language" "Language" NOT NULL DEFAULT 'en';

-- AlterTable
ALTER TABLE "tenants"
  ADD COLUMN "logo_url" TEXT,
  ADD COLUMN "contact_email" TEXT,
  ADD COLUMN "contact_phone" TEXT,
  ADD COLUMN "address_line1" TEXT,
  ADD COLUMN "address_line2" TEXT,
  ADD COLUMN "city" TEXT,
  ADD COLUMN "district" TEXT,
  ADD COLUMN "postal_code" TEXT,
  ADD COLUMN "country" TEXT NOT NULL DEFAULT 'BD',
  ADD COLUMN "currency" TEXT NOT NULL DEFAULT 'BDT',
  ADD COLUMN "timezone" TEXT NOT NULL DEFAULT 'Asia/Dhaka',
  ADD COLUMN "default_language" "Language" NOT NULL DEFAULT 'en';

-- A person may READ the businesses they belong to from any context (the workspace switcher lists them
-- before a business is chosen). The policy hangs off the person's own membership rows, so it can never
-- reveal a business they are not in; writes stay confined to the current business by tenant_isolation.
CREATE POLICY tenants_member_select ON tenants FOR SELECT
  USING (EXISTS (
    SELECT 1 FROM memberships m
    WHERE m.tenant_id = tenants.id AND m.user_id = app_current_user()
  ));
