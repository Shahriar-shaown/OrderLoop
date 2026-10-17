-- CreateEnum
CREATE TYPE "ProductStatus" AS ENUM ('ACTIVE', 'ARCHIVED');

-- CreateEnum
CREATE TYPE "StockMovementType" AS ENUM ('RECEIVE', 'ADJUSTMENT', 'RESERVE', 'RELEASE', 'SHIP');

-- CreateEnum
CREATE TYPE "ReservationStatus" AS ENUM ('ACTIVE', 'RELEASED', 'FULFILLED');

-- CreateEnum
CREATE TYPE "ImportStatus" AS ENUM ('PENDING', 'RUNNING', 'COMPLETED', 'FAILED');

-- CreateTable
CREATE TABLE "categories" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "name_key" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "categories_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "products" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "name_key" TEXT NOT NULL,
    "description" TEXT,
    "category_id" UUID,
    "unit" TEXT NOT NULL DEFAULT 'pcs',
    "status" "ProductStatus" NOT NULL DEFAULT 'ACTIVE',
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "products_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "product_variants" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "product_id" UUID NOT NULL,
    "sku" TEXT NOT NULL,
    "name" TEXT NOT NULL DEFAULT '',
    "attributes" JSONB NOT NULL DEFAULT '{}',
    "price_minor" INTEGER NOT NULL,
    "cost_minor" INTEGER,
    "barcode" TEXT,
    "reorder_point" INTEGER NOT NULL DEFAULT 0,
    "archived_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "product_variants_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "stock_locations" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "name_key" TEXT NOT NULL,
    "is_default" BOOLEAN NOT NULL DEFAULT false,
    "archived_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "stock_locations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "stock_levels" (
    "tenant_id" UUID NOT NULL,
    "variant_id" UUID NOT NULL,
    "location_id" UUID NOT NULL,
    "on_hand" INTEGER NOT NULL DEFAULT 0,
    "reserved" INTEGER NOT NULL DEFAULT 0,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "stock_levels_pkey" PRIMARY KEY ("tenant_id","variant_id","location_id")
);

-- CreateTable
CREATE TABLE "stock_movements" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "variant_id" UUID NOT NULL,
    "location_id" UUID NOT NULL,
    "type" "StockMovementType" NOT NULL,
    "on_hand_delta" INTEGER NOT NULL,
    "reserved_delta" INTEGER NOT NULL,
    "reason" TEXT,
    "reference_type" TEXT,
    "reference_id" TEXT,
    "reservation_id" UUID,
    "idempotency_key" TEXT,
    "created_by_id" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "stock_movements_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "reservations" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "variant_id" UUID NOT NULL,
    "location_id" UUID NOT NULL,
    "quantity" INTEGER NOT NULL,
    "status" "ReservationStatus" NOT NULL DEFAULT 'ACTIVE',
    "reference_type" TEXT,
    "reference_id" TEXT,
    "created_by_id" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolved_at" TIMESTAMPTZ(3),

    CONSTRAINT "reservations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "import_jobs" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "kind" TEXT NOT NULL,
    "status" "ImportStatus" NOT NULL DEFAULT 'PENDING',
    "csv" TEXT,
    "total_rows" INTEGER,
    "created" INTEGER NOT NULL DEFAULT 0,
    "updated" INTEGER NOT NULL DEFAULT 0,
    "failed" INTEGER NOT NULL DEFAULT 0,
    "errors" JSONB NOT NULL DEFAULT '[]',
    "created_by_id" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "started_at" TIMESTAMPTZ(3),
    "finished_at" TIMESTAMPTZ(3),

    CONSTRAINT "import_jobs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "categories_tenant_id_id_key" ON "categories"("tenant_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "categories_tenant_id_name_key_key" ON "categories"("tenant_id", "name_key");

-- CreateIndex
CREATE INDEX "products_tenant_id_name_key_idx" ON "products"("tenant_id", "name_key");

-- CreateIndex
CREATE INDEX "products_tenant_id_status_created_at_idx" ON "products"("tenant_id", "status", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "products_tenant_id_id_key" ON "products"("tenant_id", "id");

-- CreateIndex
CREATE INDEX "product_variants_tenant_id_product_id_idx" ON "product_variants"("tenant_id", "product_id");

-- CreateIndex
CREATE UNIQUE INDEX "product_variants_tenant_id_id_key" ON "product_variants"("tenant_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "product_variants_tenant_id_sku_key" ON "product_variants"("tenant_id", "sku");

-- CreateIndex
CREATE UNIQUE INDEX "stock_locations_tenant_id_id_key" ON "stock_locations"("tenant_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "stock_locations_tenant_id_name_key_key" ON "stock_locations"("tenant_id", "name_key");

-- CreateIndex
CREATE INDEX "stock_movements_tenant_id_variant_id_created_at_idx" ON "stock_movements"("tenant_id", "variant_id", "created_at");

-- CreateIndex
CREATE INDEX "stock_movements_tenant_id_created_at_idx" ON "stock_movements"("tenant_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "stock_movements_tenant_id_idempotency_key_key" ON "stock_movements"("tenant_id", "idempotency_key");

-- CreateIndex
CREATE INDEX "reservations_tenant_id_status_created_at_idx" ON "reservations"("tenant_id", "status", "created_at");

-- CreateIndex
CREATE INDEX "reservations_tenant_id_variant_id_idx" ON "reservations"("tenant_id", "variant_id");

-- CreateIndex
CREATE INDEX "import_jobs_tenant_id_created_at_idx" ON "import_jobs"("tenant_id", "created_at");

-- AddForeignKey
ALTER TABLE "categories" ADD CONSTRAINT "categories_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "products" ADD CONSTRAINT "products_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "products" ADD CONSTRAINT "products_category_id_fkey" FOREIGN KEY ("category_id") REFERENCES "categories"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "product_variants" ADD CONSTRAINT "product_variants_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "product_variants" ADD CONSTRAINT "product_variants_tenant_id_product_id_fkey" FOREIGN KEY ("tenant_id", "product_id") REFERENCES "products"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_locations" ADD CONSTRAINT "stock_locations_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_levels" ADD CONSTRAINT "stock_levels_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_levels" ADD CONSTRAINT "stock_levels_tenant_id_variant_id_fkey" FOREIGN KEY ("tenant_id", "variant_id") REFERENCES "product_variants"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_levels" ADD CONSTRAINT "stock_levels_tenant_id_location_id_fkey" FOREIGN KEY ("tenant_id", "location_id") REFERENCES "stock_locations"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_movements" ADD CONSTRAINT "stock_movements_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_movements" ADD CONSTRAINT "stock_movements_tenant_id_variant_id_fkey" FOREIGN KEY ("tenant_id", "variant_id") REFERENCES "product_variants"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_movements" ADD CONSTRAINT "stock_movements_tenant_id_location_id_fkey" FOREIGN KEY ("tenant_id", "location_id") REFERENCES "stock_locations"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reservations" ADD CONSTRAINT "reservations_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reservations" ADD CONSTRAINT "reservations_tenant_id_variant_id_fkey" FOREIGN KEY ("tenant_id", "variant_id") REFERENCES "product_variants"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reservations" ADD CONSTRAINT "reservations_tenant_id_location_id_fkey" FOREIGN KEY ("tenant_id", "location_id") REFERENCES "stock_locations"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "import_jobs" ADD CONSTRAINT "import_jobs_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------------------------------------------------
-- Integrity that Prisma cannot express
-- ---------------------------------------------------------------------------------------------------------------------

-- Stock can never go negative, reserved can never exceed what is on the shelf (so overselling is impossible even if
-- application code is wrong), and quantities stay far from the 32-bit limit.
ALTER TABLE stock_levels
  ADD CONSTRAINT stock_levels_on_hand_nonneg CHECK (on_hand >= 0),
  ADD CONSTRAINT stock_levels_reserved_nonneg CHECK (reserved >= 0),
  ADD CONSTRAINT stock_levels_reserved_le_on_hand CHECK (reserved <= on_hand),
  ADD CONSTRAINT stock_levels_on_hand_max CHECK (on_hand <= 1000000000);

-- Each ledger row must have the shape of its type, so the ledger itself cannot describe an impossible change.
ALTER TABLE stock_movements
  ADD CONSTRAINT stock_movements_shape CHECK (
    (type = 'RECEIVE'    AND on_hand_delta > 0 AND reserved_delta = 0) OR
    (type = 'ADJUSTMENT' AND on_hand_delta <> 0 AND reserved_delta = 0) OR
    (type = 'RESERVE'    AND on_hand_delta = 0 AND reserved_delta > 0) OR
    (type = 'RELEASE'    AND on_hand_delta = 0 AND reserved_delta < 0) OR
    (type = 'SHIP'       AND on_hand_delta < 0 AND reserved_delta = on_hand_delta)
  );

ALTER TABLE reservations ADD CONSTRAINT reservations_quantity_positive CHECK (quantity > 0);

-- Money is integer paisa: never negative.
ALTER TABLE product_variants
  ADD CONSTRAINT product_variants_price_nonneg CHECK (price_minor >= 0),
  ADD CONSTRAINT product_variants_cost_nonneg CHECK (cost_minor IS NULL OR cost_minor >= 0),
  ADD CONSTRAINT product_variants_reorder_nonneg CHECK (reorder_point >= 0);

-- At most one default location per tenant.
CREATE UNIQUE INDEX stock_locations_one_default_per_tenant ON stock_locations (tenant_id) WHERE is_default;

-- ---------------------------------------------------------------------------------------------------------------------
-- Row-level security: every new table is tenant-scoped and forced (see the earlier rls migration for the rationale).
-- ---------------------------------------------------------------------------------------------------------------------
ALTER TABLE categories       ENABLE ROW LEVEL SECURITY;
ALTER TABLE categories       FORCE  ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON categories       USING (tenant_id = app_current_tenant()) WITH CHECK (tenant_id = app_current_tenant());

ALTER TABLE products         ENABLE ROW LEVEL SECURITY;
ALTER TABLE products         FORCE  ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON products         USING (tenant_id = app_current_tenant()) WITH CHECK (tenant_id = app_current_tenant());

ALTER TABLE product_variants ENABLE ROW LEVEL SECURITY;
ALTER TABLE product_variants FORCE  ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON product_variants USING (tenant_id = app_current_tenant()) WITH CHECK (tenant_id = app_current_tenant());

ALTER TABLE stock_locations  ENABLE ROW LEVEL SECURITY;
ALTER TABLE stock_locations  FORCE  ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON stock_locations  USING (tenant_id = app_current_tenant()) WITH CHECK (tenant_id = app_current_tenant());

ALTER TABLE stock_levels     ENABLE ROW LEVEL SECURITY;
ALTER TABLE stock_levels     FORCE  ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON stock_levels     USING (tenant_id = app_current_tenant()) WITH CHECK (tenant_id = app_current_tenant());

ALTER TABLE reservations     ENABLE ROW LEVEL SECURITY;
ALTER TABLE reservations     FORCE  ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON reservations     USING (tenant_id = app_current_tenant()) WITH CHECK (tenant_id = app_current_tenant());

ALTER TABLE import_jobs      ENABLE ROW LEVEL SECURITY;
ALTER TABLE import_jobs      FORCE  ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON import_jobs      USING (tenant_id = app_current_tenant()) WITH CHECK (tenant_id = app_current_tenant());

-- The ledger is append-only: separate read and insert policies, and no UPDATE, DELETE or TRUNCATE grant at all.
ALTER TABLE stock_movements  ENABLE ROW LEVEL SECURITY;
ALTER TABLE stock_movements  FORCE  ROW LEVEL SECURITY;
CREATE POLICY ledger_select ON stock_movements FOR SELECT USING (tenant_id = app_current_tenant());
CREATE POLICY ledger_insert ON stock_movements FOR INSERT WITH CHECK (tenant_id = app_current_tenant());
REVOKE UPDATE, DELETE, TRUNCATE ON stock_movements FROM app_user;
