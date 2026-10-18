-- Suppliers, product images, and damaged stock.

CREATE TABLE "suppliers" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "name_key" TEXT NOT NULL,
    "contact_name" TEXT,
    "phone" TEXT,
    "email" TEXT,
    "address" TEXT,
    "notes" TEXT,
    "archived_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "suppliers_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "suppliers_tenant_id_id_key" ON "suppliers"("tenant_id", "id");
CREATE UNIQUE INDEX "suppliers_tenant_id_name_key_key" ON "suppliers"("tenant_id", "name_key");
ALTER TABLE "suppliers" ADD CONSTRAINT "suppliers_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "products"
  ADD COLUMN "supplier_id" UUID,
  ADD COLUMN "image_urls" TEXT[] DEFAULT ARRAY[]::TEXT[];
ALTER TABLE "products" ADD CONSTRAINT "products_supplier_id_fkey" FOREIGN KEY ("supplier_id") REFERENCES "suppliers"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "stock_levels" ADD COLUMN "damaged" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "stock_movements" ADD COLUMN "damaged_delta" INTEGER NOT NULL DEFAULT 0;

ALTER TABLE stock_levels
  ADD CONSTRAINT stock_levels_damaged_nonneg CHECK (damaged >= 0),
  ADD CONSTRAINT stock_levels_damaged_max CHECK (damaged <= 1000000000);

-- The ledger shape now includes the damaged bucket. Existing types never touch it.
ALTER TABLE stock_movements DROP CONSTRAINT stock_movements_shape;
ALTER TABLE stock_movements
  ADD CONSTRAINT stock_movements_shape CHECK (
    (type = 'RECEIVE'    AND on_hand_delta > 0 AND reserved_delta = 0 AND damaged_delta = 0) OR
    (type = 'ADJUSTMENT' AND on_hand_delta <> 0 AND reserved_delta = 0 AND damaged_delta = 0) OR
    (type = 'RESERVE'    AND on_hand_delta = 0 AND reserved_delta > 0 AND damaged_delta = 0) OR
    (type = 'RELEASE'    AND on_hand_delta = 0 AND reserved_delta < 0 AND damaged_delta = 0) OR
    (type = 'SHIP'       AND on_hand_delta < 0 AND reserved_delta = on_hand_delta AND damaged_delta = 0) OR
    (type = 'DAMAGE'     AND on_hand_delta < 0 AND reserved_delta = 0 AND damaged_delta = -on_hand_delta) OR
    (type = 'WRITE_OFF'  AND on_hand_delta = 0 AND reserved_delta = 0 AND damaged_delta < 0) OR
    (type = 'RETURN'     AND reserved_delta = 0 AND (
        (on_hand_delta > 0 AND damaged_delta = 0) OR (on_hand_delta = 0 AND damaged_delta > 0)))
  );

-- Row-level security, as on every tenant table.
ALTER TABLE suppliers ENABLE ROW LEVEL SECURITY;
ALTER TABLE suppliers FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON suppliers
  USING (tenant_id = app_current_tenant())
  WITH CHECK (tenant_id = app_current_tenant());
