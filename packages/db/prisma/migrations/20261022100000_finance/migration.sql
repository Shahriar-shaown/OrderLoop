-- CreateEnum
CREATE TYPE "SettlementKind" AS ENUM ('cod', 'return', 'adjustment');

-- CreateEnum
CREATE TYPE "SettlementMatchStatus" AS ENUM ('matched', 'unmatched', 'ambiguous', 'unallocated', 'duplicate', 'ignored');

-- CreateEnum
CREATE TYPE "SettlementMatchMethod" AS ENUM ('consignment_id', 'tracking_code', 'reference', 'order_number', 'manual');

-- CreateEnum
CREATE TYPE "DiscrepancyType" AS ENUM ('short_paid', 'over_paid', 'cash_before_delivery', 'cash_on_closed_order', 'fee_differs', 'file_arithmetic');

-- CreateEnum
CREATE TYPE "DiscrepancyStatus" AS ENUM ('open', 'resolved', 'waived');

-- CreateEnum
CREATE TYPE "CostKind" AS ENUM ('packaging', 'advertising', 'delivery_charge', 'return_charge', 'courier_deduction', 'other');

-- CreateTable
CREATE TABLE "settlement_batches" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "provider" "CourierProvider" NOT NULL,
    "file_name" TEXT,
    "file_hash" TEXT NOT NULL,
    "statement_ref" TEXT,
    "row_count" INTEGER NOT NULL,
    "created_by_id" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "reconciled_at" TIMESTAMPTZ(3),
    "reconciled_by_id" UUID,

    CONSTRAINT "settlement_batches_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "settlement_items" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "batch_id" UUID NOT NULL,
    "line_no" INTEGER NOT NULL,
    "item_key" TEXT NOT NULL,
    "kind" "SettlementKind" NOT NULL,
    "transaction_id" TEXT,
    "consignment_id" TEXT,
    "tracking_code" TEXT,
    "reference" TEXT,
    "phone" TEXT,
    "item_date" DATE NOT NULL,
    "collected_minor" INTEGER NOT NULL,
    "delivery_charge_minor" INTEGER NOT NULL,
    "cod_fee_minor" INTEGER NOT NULL,
    "return_charge_minor" INTEGER NOT NULL,
    "other_deduction_minor" INTEGER NOT NULL,
    "net_minor" INTEGER NOT NULL,
    "file_net_minor" INTEGER,
    "note" TEXT,
    "raw" JSONB NOT NULL,
    "match_status" "SettlementMatchStatus" NOT NULL,
    "match_method" "SettlementMatchMethod",
    "match_note" TEXT,
    "shipment_id" UUID,
    "order_id" UUID,
    "duplicate_of_id" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "settlement_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "settlement_item_events" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "item_id" UUID NOT NULL,
    "action" TEXT NOT NULL,
    "actor_user_id" UUID,
    "note" TEXT,
    "data" JSONB,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "settlement_item_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "discrepancies" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "type" "DiscrepancyType" NOT NULL,
    "subject_key" TEXT NOT NULL,
    "item_id" UUID,
    "shipment_id" UUID,
    "order_id" UUID,
    "status" "DiscrepancyStatus" NOT NULL DEFAULT 'open',
    "expected_minor" INTEGER,
    "actual_minor" INTEGER,
    "message" TEXT NOT NULL,
    "closed_actual_minor" INTEGER,
    "resolution" TEXT,
    "resolved_by_id" UUID,
    "resolved_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "discrepancies_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "manual_costs" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "kind" "CostKind" NOT NULL,
    "amount_minor" INTEGER NOT NULL,
    "incurred_on" DATE NOT NULL,
    "order_id" UUID,
    "note" TEXT NOT NULL,
    "idempotency_key" TEXT NOT NULL,
    "request_hash" TEXT NOT NULL,
    "voided_at" TIMESTAMPTZ(3),
    "voided_by_id" UUID,
    "void_reason" TEXT,
    "created_by_id" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "manual_costs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "settlement_batches_tenant_id_created_at_idx" ON "settlement_batches"("tenant_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "settlement_batches_tenant_id_id_key" ON "settlement_batches"("tenant_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "settlement_batches_tenant_id_file_hash_key" ON "settlement_batches"("tenant_id", "file_hash");

-- CreateIndex
CREATE INDEX "settlement_items_tenant_id_batch_id_idx" ON "settlement_items"("tenant_id", "batch_id");

-- CreateIndex
CREATE INDEX "settlement_items_tenant_id_shipment_id_idx" ON "settlement_items"("tenant_id", "shipment_id");

-- CreateIndex
CREATE INDEX "settlement_items_tenant_id_order_id_idx" ON "settlement_items"("tenant_id", "order_id");

-- CreateIndex
CREATE INDEX "settlement_items_tenant_id_match_status_idx" ON "settlement_items"("tenant_id", "match_status");

-- CreateIndex
CREATE INDEX "settlement_items_tenant_id_item_date_idx" ON "settlement_items"("tenant_id", "item_date");

-- CreateIndex
CREATE UNIQUE INDEX "settlement_items_tenant_id_id_key" ON "settlement_items"("tenant_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "settlement_items_tenant_id_batch_id_line_no_key" ON "settlement_items"("tenant_id", "batch_id", "line_no");

-- CreateIndex
CREATE INDEX "settlement_item_events_tenant_id_item_id_created_at_idx" ON "settlement_item_events"("tenant_id", "item_id", "created_at");

-- CreateIndex
CREATE INDEX "discrepancies_tenant_id_status_idx" ON "discrepancies"("tenant_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "discrepancies_tenant_id_subject_key_type_key" ON "discrepancies"("tenant_id", "subject_key", "type");

-- CreateIndex
CREATE INDEX "manual_costs_tenant_id_incurred_on_idx" ON "manual_costs"("tenant_id", "incurred_on");

-- CreateIndex
CREATE UNIQUE INDEX "manual_costs_tenant_id_id_key" ON "manual_costs"("tenant_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "manual_costs_tenant_id_idempotency_key_key" ON "manual_costs"("tenant_id", "idempotency_key");

-- AddForeignKey
ALTER TABLE "settlement_batches" ADD CONSTRAINT "settlement_batches_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "settlement_items" ADD CONSTRAINT "settlement_items_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "settlement_items" ADD CONSTRAINT "settlement_items_tenant_id_batch_id_fkey" FOREIGN KEY ("tenant_id", "batch_id") REFERENCES "settlement_batches"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "settlement_items" ADD CONSTRAINT "settlement_items_tenant_id_shipment_id_fkey" FOREIGN KEY ("tenant_id", "shipment_id") REFERENCES "shipments"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "settlement_items" ADD CONSTRAINT "settlement_items_tenant_id_order_id_fkey" FOREIGN KEY ("tenant_id", "order_id") REFERENCES "orders"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "settlement_item_events" ADD CONSTRAINT "settlement_item_events_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "settlement_item_events" ADD CONSTRAINT "settlement_item_events_tenant_id_item_id_fkey" FOREIGN KEY ("tenant_id", "item_id") REFERENCES "settlement_items"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "discrepancies" ADD CONSTRAINT "discrepancies_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "discrepancies" ADD CONSTRAINT "discrepancies_tenant_id_item_id_fkey" FOREIGN KEY ("tenant_id", "item_id") REFERENCES "settlement_items"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "discrepancies" ADD CONSTRAINT "discrepancies_tenant_id_shipment_id_fkey" FOREIGN KEY ("tenant_id", "shipment_id") REFERENCES "shipments"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "discrepancies" ADD CONSTRAINT "discrepancies_tenant_id_order_id_fkey" FOREIGN KEY ("tenant_id", "order_id") REFERENCES "orders"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "manual_costs" ADD CONSTRAINT "manual_costs_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "manual_costs" ADD CONSTRAINT "manual_costs_tenant_id_order_id_fkey" FOREIGN KEY ("tenant_id", "order_id") REFERENCES "orders"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------------------------------------------------
-- Integrity that Prisma cannot express. Financial records are checked by the database as well as by the application.
-- ---------------------------------------------------------------------------------------------------------------------

-- The same statement line is recorded once. Lines found to repeat an earlier one are kept (flagged duplicate) but sit outside
-- this index, so they can never be counted twice.
CREATE UNIQUE INDEX settlement_items_one_counted ON settlement_items (tenant_id, item_key) WHERE match_status <> 'duplicate';

ALTER TABLE settlement_items
  ADD CONSTRAINT settlement_items_amounts_nonneg CHECK (
    collected_minor >= 0 AND delivery_charge_minor >= 0 AND cod_fee_minor >= 0 AND return_charge_minor >= 0 AND other_deduction_minor >= 0),
  ADD CONSTRAINT settlement_items_amounts_max CHECK (
    collected_minor <= 2000000000 AND delivery_charge_minor <= 2000000000 AND cod_fee_minor <= 2000000000 AND
    return_charge_minor <= 2000000000 AND other_deduction_minor <= 2000000000),
  ADD CONSTRAINT settlement_items_net_adds_up CHECK (
    net_minor = collected_minor - delivery_charge_minor - cod_fee_minor - return_charge_minor - other_deduction_minor),
  ADD CONSTRAINT settlement_items_return_has_no_cash CHECK (kind <> 'return' OR collected_minor = 0),
  -- A line is tied to a parcel exactly when it is matched; a duplicate points at the line it repeats.
  ADD CONSTRAINT settlement_items_match_consistent CHECK (
    (match_status = 'matched') = (shipment_id IS NOT NULL AND order_id IS NOT NULL AND match_method IS NOT NULL)),
  ADD CONSTRAINT settlement_items_duplicate_points CHECK ((match_status = 'duplicate') = (duplicate_of_id IS NOT NULL));

ALTER TABLE manual_costs
  ADD CONSTRAINT manual_costs_amount_positive CHECK (amount_minor > 0 AND amount_minor <= 2000000000),
  ADD CONSTRAINT manual_costs_void_complete CHECK ((voided_at IS NULL) = (voided_by_id IS NULL AND void_reason IS NULL) OR voided_by_id IS NOT NULL);

ALTER TABLE discrepancies
  ADD CONSTRAINT discrepancies_closed_has_reason CHECK (status = 'open' OR resolution IS NOT NULL);

-- ---------------------------------------------------------------------------------------------------------------------
-- Row-level security, as on every tenant table.
-- ---------------------------------------------------------------------------------------------------------------------
ALTER TABLE settlement_batches      ENABLE ROW LEVEL SECURITY;
ALTER TABLE settlement_batches      FORCE  ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON settlement_batches      USING (tenant_id = app_current_tenant()) WITH CHECK (tenant_id = app_current_tenant());
ALTER TABLE settlement_items        ENABLE ROW LEVEL SECURITY;
ALTER TABLE settlement_items        FORCE  ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON settlement_items        USING (tenant_id = app_current_tenant()) WITH CHECK (tenant_id = app_current_tenant());
ALTER TABLE settlement_item_events  ENABLE ROW LEVEL SECURITY;
ALTER TABLE settlement_item_events  FORCE  ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON settlement_item_events  USING (tenant_id = app_current_tenant()) WITH CHECK (tenant_id = app_current_tenant());
ALTER TABLE discrepancies           ENABLE ROW LEVEL SECURITY;
ALTER TABLE discrepancies           FORCE  ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON discrepancies           USING (tenant_id = app_current_tenant()) WITH CHECK (tenant_id = app_current_tenant());
ALTER TABLE manual_costs            ENABLE ROW LEVEL SECURITY;
ALTER TABLE manual_costs            FORCE  ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON manual_costs            USING (tenant_id = app_current_tenant()) WITH CHECK (tenant_id = app_current_tenant());

-- Financial records are never deleted by the application: a line is ignored, a cost is voided, a difference is resolved.
REVOKE DELETE, TRUNCATE ON settlement_batches, settlement_items, discrepancies, manual_costs FROM app_user;
-- What happened to a line is a record: add to it and read it, never rewrite it.
REVOKE UPDATE, DELETE, TRUNCATE ON settlement_item_events FROM app_user;
