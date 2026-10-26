-- Cash the business itself collected for a delivered COD order (own rider, hand-over, pick-up). A person records it; no courier
-- reported it. It counts toward the order's collected cash beside matched statement lines. See docs/finance.md.

-- CreateTable
CREATE TABLE "cod_receipts" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "order_id" UUID NOT NULL,
    "amount_minor" INTEGER NOT NULL,
    "received_on" DATE NOT NULL,
    "note" TEXT,
    "idempotency_key" TEXT NOT NULL,
    "request_hash" TEXT NOT NULL,
    "voided_at" TIMESTAMPTZ(3),
    "voided_by_id" UUID,
    "void_reason" TEXT,
    "created_by_id" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "cod_receipts_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "cod_receipts_tenant_id_id_key" ON "cod_receipts"("tenant_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "cod_receipts_tenant_id_idempotency_key_key" ON "cod_receipts"("tenant_id", "idempotency_key");

-- CreateIndex
CREATE INDEX "cod_receipts_tenant_id_order_id_idx" ON "cod_receipts"("tenant_id", "order_id");

-- CreateIndex
CREATE INDEX "cod_receipts_tenant_id_received_on_idx" ON "cod_receipts"("tenant_id", "received_on");

-- AddForeignKey
ALTER TABLE "cod_receipts" ADD CONSTRAINT "cod_receipts_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cod_receipts" ADD CONSTRAINT "cod_receipts_tenant_id_order_id_fkey" FOREIGN KEY ("tenant_id", "order_id") REFERENCES "orders"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------------------------------------------------
-- Integrity the application cannot be trusted alone to keep.
-- ---------------------------------------------------------------------------------------------------------------------
ALTER TABLE cod_receipts
  ADD CONSTRAINT cod_receipts_amount_positive CHECK (amount_minor > 0 AND amount_minor <= 2000000000),
  -- A void carries who did it and why, all or nothing.
  ADD CONSTRAINT cod_receipts_void_complete CHECK (
    (voided_at IS NULL AND voided_by_id IS NULL AND void_reason IS NULL)
    OR (voided_at IS NOT NULL AND voided_by_id IS NOT NULL AND void_reason IS NOT NULL));

ALTER TABLE cod_receipts ENABLE ROW LEVEL SECURITY;
ALTER TABLE cod_receipts FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON cod_receipts USING (tenant_id = app_current_tenant()) WITH CHECK (tenant_id = app_current_tenant());

-- A receipt is a financial record: never deleted, and the only thing that may change on it is that it is voided.
REVOKE DELETE, TRUNCATE ON cod_receipts FROM app_user;
REVOKE UPDATE ON cod_receipts FROM app_user;
GRANT UPDATE (voided_at, voided_by_id, void_reason) ON cod_receipts TO app_user;

-- ---------------------------------------------------------------------------------------------------------------------
-- The business purge and the customer erasure keep their own lists of tables and free-text columns (20261031100000_data_deletion,
-- 20261101100000_tiktok_shop). Add the new table to both by rewriting the live definitions, so nothing else in them is retyped.
-- ---------------------------------------------------------------------------------------------------------------------
DO $$
DECLARE
  def text;
  changed text;
BEGIN
  def := pg_get_functiondef('purge_tenant(uuid)'::regprocedure);
  changed := replace(def, '''manual_costs'', ''shipment_events''', '''cod_receipts'', ''manual_costs'', ''shipment_events''');
  IF changed = def THEN RAISE EXCEPTION 'purge_tenant: the table list was not found'; END IF;
  EXECUTE changed;

  def := pg_get_functiondef('erase_customer(uuid, uuid, text)'::regprocedure);
  changed := replace(def, '''manual_costs.note'', ''manual_costs.void_reason'',',
                     '''manual_costs.note'', ''manual_costs.void_reason'', ''cod_receipts.note'', ''cod_receipts.void_reason'',');
  IF changed = def THEN RAISE EXCEPTION 'erase_customer: the free-text list was not found'; END IF;
  EXECUTE changed;
END
$$;
