-- CreateEnum
CREATE TYPE "CourierProvider" AS ENUM ('mock', 'pathao', 'steadfast');

-- CreateEnum
CREATE TYPE "CourierEnvironment" AS ENUM ('simulated', 'sandbox', 'production');

-- CreateEnum
CREATE TYPE "ShipmentStatus" AS ENUM ('booking', 'booking_failed', 'booking_uncertain', 'booked', 'picked_up', 'in_transit', 'out_for_delivery', 'delivered', 'partial_delivered', 'delivery_failed', 'on_hold', 'returning', 'returned', 'cancelled', 'unknown');

-- CreateEnum
CREATE TYPE "ShipmentEventSource" AS ENUM ('booking', 'webhook', 'poll', 'manual', 'simulation');

-- CreateTable
CREATE TABLE "courier_connections" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "provider" "CourierProvider" NOT NULL,
    "environment" "CourierEnvironment" NOT NULL,
    "credentials_enc" TEXT,
    "webhook_secret_enc" TEXT,
    "settings" JSONB NOT NULL DEFAULT '{}',
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "last_checked_at" TIMESTAMPTZ(3),
    "last_check_ok" BOOLEAN,
    "last_check_message" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "courier_connections_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "shipments" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "order_id" UUID NOT NULL,
    "connection_id" UUID NOT NULL,
    "provider" "CourierProvider" NOT NULL,
    "environment" "CourierEnvironment" NOT NULL,
    "simulated" BOOLEAN NOT NULL,
    "status" "ShipmentStatus" NOT NULL,
    "provider_status" TEXT,
    "provider_consignment_id" TEXT,
    "provider_reference" TEXT NOT NULL,
    "tracking_code" TEXT,
    "tracking_url" TEXT,
    "attempt" INTEGER NOT NULL DEFAULT 1,
    "cod_amount_minor" INTEGER NOT NULL,
    "delivery_fee_minor" INTEGER,
    "failure_reason" TEXT,
    "idempotency_key" TEXT,
    "request_hash" TEXT,
    "booked_at" TIMESTAMPTZ(3),
    "last_event_at" TIMESTAMPTZ(3),
    "last_synced_at" TIMESTAMPTZ(3),
    "created_by_id" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "shipments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "shipment_events" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "shipment_id" UUID NOT NULL,
    "source" "ShipmentEventSource" NOT NULL,
    "event_key" TEXT NOT NULL,
    "provider_status" TEXT,
    "mapped_status" "ShipmentStatus",
    "applied" BOOLEAN NOT NULL,
    "note" TEXT,
    "payload" JSONB,
    "occurred_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "shipment_events_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "courier_connections_tenant_id_id_key" ON "courier_connections"("tenant_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "courier_connections_tenant_id_provider_key" ON "courier_connections"("tenant_id", "provider");

-- CreateIndex
CREATE INDEX "shipments_tenant_id_order_id_idx" ON "shipments"("tenant_id", "order_id");

-- CreateIndex
CREATE INDEX "shipments_tenant_id_status_idx" ON "shipments"("tenant_id", "status");

-- CreateIndex
CREATE INDEX "shipments_tenant_id_provider_consignment_id_idx" ON "shipments"("tenant_id", "provider_consignment_id");

-- CreateIndex
CREATE UNIQUE INDEX "shipments_tenant_id_id_key" ON "shipments"("tenant_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "shipments_tenant_id_order_id_attempt_key" ON "shipments"("tenant_id", "order_id", "attempt");

-- CreateIndex
CREATE UNIQUE INDEX "shipments_tenant_id_idempotency_key_key" ON "shipments"("tenant_id", "idempotency_key");

-- CreateIndex
CREATE UNIQUE INDEX "shipments_tenant_id_provider_provider_reference_key" ON "shipments"("tenant_id", "provider", "provider_reference");

-- CreateIndex
CREATE INDEX "shipment_events_tenant_id_shipment_id_created_at_idx" ON "shipment_events"("tenant_id", "shipment_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "shipment_events_tenant_id_shipment_id_event_key_key" ON "shipment_events"("tenant_id", "shipment_id", "event_key");

-- AddForeignKey
ALTER TABLE "courier_connections" ADD CONSTRAINT "courier_connections_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "shipments" ADD CONSTRAINT "shipments_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "shipments" ADD CONSTRAINT "shipments_tenant_id_order_id_fkey" FOREIGN KEY ("tenant_id", "order_id") REFERENCES "orders"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "shipments" ADD CONSTRAINT "shipments_tenant_id_connection_id_fkey" FOREIGN KEY ("tenant_id", "connection_id") REFERENCES "courier_connections"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "shipment_events" ADD CONSTRAINT "shipment_events_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "shipment_events" ADD CONSTRAINT "shipment_events_tenant_id_shipment_id_fkey" FOREIGN KEY ("tenant_id", "shipment_id") REFERENCES "shipments"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------------------------------------------------
-- Integrity that Prisma cannot express.
-- ---------------------------------------------------------------------------------------------------------------------

-- One live shipment per order: a second booking cannot exist while the first is booked, being booked, or unresolved.
-- A refused, failed or cancelled booking leaves room for a fresh attempt.
CREATE UNIQUE INDEX shipments_one_live_per_order ON shipments (tenant_id, order_id)
  WHERE status NOT IN ('booking_failed', 'cancelled');

ALTER TABLE shipments
  ADD CONSTRAINT shipments_cod_nonneg CHECK (cod_amount_minor >= 0),
  ADD CONSTRAINT shipments_fee_nonneg CHECK (delivery_fee_minor IS NULL OR delivery_fee_minor >= 0),
  ADD CONSTRAINT shipments_attempt_positive CHECK (attempt >= 1),
  -- A simulated shipment can only belong to the simulated environment, and the reverse: a real parcel is never labelled simulated.
  ADD CONSTRAINT shipments_simulated_matches CHECK (simulated = (environment = 'simulated' AND provider = 'mock')),
  ADD CONSTRAINT shipments_mock_is_simulated CHECK ((provider = 'mock') = (environment = 'simulated'));

ALTER TABLE courier_connections
  ADD CONSTRAINT courier_connections_mock_is_simulated CHECK ((provider = 'mock') = (environment = 'simulated')),
  ADD CONSTRAINT courier_connections_mock_has_no_secrets CHECK (provider <> 'mock' OR (credentials_enc IS NULL AND webhook_secret_enc IS NULL));

-- ---------------------------------------------------------------------------------------------------------------------
-- Row-level security, as on every tenant table.
-- ---------------------------------------------------------------------------------------------------------------------
ALTER TABLE courier_connections ENABLE ROW LEVEL SECURITY;
ALTER TABLE courier_connections FORCE  ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON courier_connections USING (tenant_id = app_current_tenant()) WITH CHECK (tenant_id = app_current_tenant());
ALTER TABLE shipments           ENABLE ROW LEVEL SECURITY;
ALTER TABLE shipments           FORCE  ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON shipments           USING (tenant_id = app_current_tenant()) WITH CHECK (tenant_id = app_current_tenant());
ALTER TABLE shipment_events     ENABLE ROW LEVEL SECURITY;
ALTER TABLE shipment_events     FORCE  ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON shipment_events     USING (tenant_id = app_current_tenant()) WITH CHECK (tenant_id = app_current_tenant());

-- What the courier told us is a record: the application role may add to it and read it, never rewrite it.
REVOKE UPDATE, DELETE, TRUNCATE ON shipment_events FROM app_user;
