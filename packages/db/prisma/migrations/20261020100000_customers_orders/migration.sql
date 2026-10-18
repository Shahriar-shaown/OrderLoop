-- CreateEnum
CREATE TYPE "OrderStatus" AS ENUM ('pending_confirmation', 'confirmed', 'ready_to_ship', 'shipped', 'in_transit', 'delivered', 'delivery_failed', 'cancelled', 'return_requested', 'returned');

-- CreateEnum
CREATE TYPE "OrderSource" AS ENUM ('facebook', 'instagram', 'whatsapp', 'phone_call', 'website', 'walk_in', 'other');

-- CreateTable
CREATE TABLE "customers" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "name_key" TEXT NOT NULL,
    "phone" TEXT NOT NULL,
    "email" TEXT,
    "notes" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "customers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "customer_addresses" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "customer_id" UUID NOT NULL,
    "label" TEXT,
    "recipient_name" TEXT NOT NULL,
    "phone" TEXT NOT NULL,
    "line1" TEXT NOT NULL,
    "area" TEXT NOT NULL,
    "district" TEXT NOT NULL,
    "division" TEXT NOT NULL,
    "postal_code" TEXT,
    "is_default" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "customer_addresses_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "order_counters" (
    "tenant_id" UUID NOT NULL,
    "next_number" INTEGER NOT NULL DEFAULT 1001,

    CONSTRAINT "order_counters_pkey" PRIMARY KEY ("tenant_id")
);

-- CreateTable
CREATE TABLE "orders" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "order_number" INTEGER NOT NULL,
    "customer_id" UUID NOT NULL,
    "status" "OrderStatus" NOT NULL DEFAULT 'pending_confirmation',
    "source" "OrderSource" NOT NULL DEFAULT 'other',
    "source_reference" TEXT,
    "notes" TEXT,
    "ship_name" TEXT NOT NULL,
    "ship_phone" TEXT NOT NULL,
    "ship_line1" TEXT NOT NULL,
    "ship_area" TEXT NOT NULL,
    "ship_district" TEXT NOT NULL,
    "ship_division" TEXT NOT NULL,
    "ship_postal_code" TEXT,
    "subtotal_minor" INTEGER NOT NULL,
    "discount_minor" INTEGER NOT NULL DEFAULT 0,
    "delivery_charge_minor" INTEGER NOT NULL DEFAULT 0,
    "total_minor" INTEGER NOT NULL,
    "advance_paid_minor" INTEGER NOT NULL DEFAULT 0,
    "cod_amount_minor" INTEGER NOT NULL,
    "idempotency_key" TEXT,
    "request_hash" TEXT,
    "version" INTEGER NOT NULL DEFAULT 1,
    "created_by_id" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "orders_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "order_items" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "order_id" UUID NOT NULL,
    "position" INTEGER NOT NULL,
    "variant_id" UUID NOT NULL,
    "sku" TEXT NOT NULL,
    "product_name" TEXT NOT NULL,
    "variant_name" TEXT NOT NULL DEFAULT '',
    "quantity" INTEGER NOT NULL,
    "unit_price_minor" INTEGER NOT NULL,
    "discount_minor" INTEGER NOT NULL DEFAULT 0,
    "line_total_minor" INTEGER NOT NULL,
    "cost_minor" INTEGER,
    "reservation_id" UUID,

    CONSTRAINT "order_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "order_status_history" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "order_id" UUID NOT NULL,
    "from_status" "OrderStatus",
    "to_status" "OrderStatus" NOT NULL,
    "reason" TEXT,
    "actor_user_id" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "order_status_history_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "customers_tenant_id_name_key_idx" ON "customers"("tenant_id", "name_key");

-- CreateIndex
CREATE UNIQUE INDEX "customers_tenant_id_id_key" ON "customers"("tenant_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "customers_tenant_id_phone_key" ON "customers"("tenant_id", "phone");

-- CreateIndex
CREATE INDEX "customer_addresses_tenant_id_customer_id_idx" ON "customer_addresses"("tenant_id", "customer_id");

-- CreateIndex
CREATE UNIQUE INDEX "customer_addresses_tenant_id_id_key" ON "customer_addresses"("tenant_id", "id");

-- CreateIndex
CREATE INDEX "orders_tenant_id_status_created_at_idx" ON "orders"("tenant_id", "status", "created_at");

-- CreateIndex
CREATE INDEX "orders_tenant_id_customer_id_created_at_idx" ON "orders"("tenant_id", "customer_id", "created_at");

-- CreateIndex
CREATE INDEX "orders_tenant_id_created_at_idx" ON "orders"("tenant_id", "created_at");

-- CreateIndex
CREATE INDEX "orders_tenant_id_ship_phone_idx" ON "orders"("tenant_id", "ship_phone");

-- CreateIndex
CREATE UNIQUE INDEX "orders_tenant_id_id_key" ON "orders"("tenant_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "orders_tenant_id_order_number_key" ON "orders"("tenant_id", "order_number");

-- CreateIndex
CREATE UNIQUE INDEX "orders_tenant_id_idempotency_key_key" ON "orders"("tenant_id", "idempotency_key");

-- CreateIndex
CREATE INDEX "order_items_tenant_id_order_id_idx" ON "order_items"("tenant_id", "order_id");

-- CreateIndex
CREATE INDEX "order_items_tenant_id_variant_id_idx" ON "order_items"("tenant_id", "variant_id");

-- CreateIndex
CREATE UNIQUE INDEX "order_items_tenant_id_id_key" ON "order_items"("tenant_id", "id");

-- CreateIndex
CREATE INDEX "order_status_history_tenant_id_order_id_created_at_idx" ON "order_status_history"("tenant_id", "order_id", "created_at");

-- AddForeignKey
ALTER TABLE "customers" ADD CONSTRAINT "customers_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "customer_addresses" ADD CONSTRAINT "customer_addresses_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "customer_addresses" ADD CONSTRAINT "customer_addresses_tenant_id_customer_id_fkey" FOREIGN KEY ("tenant_id", "customer_id") REFERENCES "customers"("tenant_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "orders" ADD CONSTRAINT "orders_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "orders" ADD CONSTRAINT "orders_tenant_id_customer_id_fkey" FOREIGN KEY ("tenant_id", "customer_id") REFERENCES "customers"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "order_items" ADD CONSTRAINT "order_items_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "order_items" ADD CONSTRAINT "order_items_tenant_id_order_id_fkey" FOREIGN KEY ("tenant_id", "order_id") REFERENCES "orders"("tenant_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "order_items" ADD CONSTRAINT "order_items_tenant_id_variant_id_fkey" FOREIGN KEY ("tenant_id", "variant_id") REFERENCES "product_variants"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "order_status_history" ADD CONSTRAINT "order_status_history_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "order_status_history" ADD CONSTRAINT "order_status_history_tenant_id_order_id_fkey" FOREIGN KEY ("tenant_id", "order_id") REFERENCES "orders"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- ---------------------------------------------------------------------------------------------------------------------
-- Integrity that Prisma cannot express: the order arithmetic is repeated here, so even a bug in the application cannot
-- store a total that does not add up.
-- ---------------------------------------------------------------------------------------------------------------------

ALTER TABLE orders
  ADD CONSTRAINT orders_money_nonneg CHECK (
    subtotal_minor >= 0 AND discount_minor >= 0 AND delivery_charge_minor >= 0 AND
    total_minor >= 0 AND advance_paid_minor >= 0 AND cod_amount_minor >= 0),
  ADD CONSTRAINT orders_discount_le_subtotal CHECK (discount_minor <= subtotal_minor),
  ADD CONSTRAINT orders_total_adds_up CHECK (total_minor = subtotal_minor - discount_minor + delivery_charge_minor),
  ADD CONSTRAINT orders_cod_adds_up CHECK (cod_amount_minor = total_minor - advance_paid_minor),
  ADD CONSTRAINT orders_total_max CHECK (total_minor <= 2000000000),
  ADD CONSTRAINT orders_version_positive CHECK (version >= 1),
  ADD CONSTRAINT orders_number_positive CHECK (order_number >= 1);

ALTER TABLE order_items
  ADD CONSTRAINT order_items_quantity_positive CHECK (quantity > 0 AND quantity <= 10000),
  ADD CONSTRAINT order_items_money_nonneg CHECK (unit_price_minor >= 0 AND discount_minor >= 0 AND line_total_minor >= 0),
  ADD CONSTRAINT order_items_line_adds_up CHECK (line_total_minor = quantity::bigint * unit_price_minor - discount_minor);

-- Only one default address per customer.
CREATE UNIQUE INDEX customer_addresses_one_default ON customer_addresses (tenant_id, customer_id) WHERE is_default;

-- ---------------------------------------------------------------------------------------------------------------------
-- Row-level security, as on every tenant table.
-- ---------------------------------------------------------------------------------------------------------------------

ALTER TABLE customers            ENABLE ROW LEVEL SECURITY;
ALTER TABLE customers            FORCE  ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON customers            USING (tenant_id = app_current_tenant()) WITH CHECK (tenant_id = app_current_tenant());

ALTER TABLE customer_addresses   ENABLE ROW LEVEL SECURITY;
ALTER TABLE customer_addresses   FORCE  ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON customer_addresses   USING (tenant_id = app_current_tenant()) WITH CHECK (tenant_id = app_current_tenant());

ALTER TABLE order_counters       ENABLE ROW LEVEL SECURITY;
ALTER TABLE order_counters       FORCE  ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON order_counters       USING (tenant_id = app_current_tenant()) WITH CHECK (tenant_id = app_current_tenant());

ALTER TABLE orders               ENABLE ROW LEVEL SECURITY;
ALTER TABLE orders               FORCE  ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON orders               USING (tenant_id = app_current_tenant()) WITH CHECK (tenant_id = app_current_tenant());

ALTER TABLE order_items          ENABLE ROW LEVEL SECURITY;
ALTER TABLE order_items          FORCE  ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON order_items          USING (tenant_id = app_current_tenant()) WITH CHECK (tenant_id = app_current_tenant());

ALTER TABLE order_status_history ENABLE ROW LEVEL SECURITY;
ALTER TABLE order_status_history FORCE  ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON order_status_history USING (tenant_id = app_current_tenant()) WITH CHECK (tenant_id = app_current_tenant());

-- The status history is a record of what happened: the application role may add to it and read it, never rewrite it.
REVOKE UPDATE, DELETE, TRUNCATE ON order_status_history FROM app_user;
