-- TikTok Shop channel (docs/tiktok-shop.md): a READ-ONLY mirror of a shop's orders, SKU links to OrderLoop variants, and the
-- holds that make every stock effect happen exactly once.
--
-- Scope decision: OrderLoop's own orders, money, phones and addresses are Bangladesh/BDT-only, and TikTok Shop is not available
-- in Bangladesh. A TikTok order arrives in the SHOP'S OWN currency with its own country's address, so it is NOT written into
-- `orders` and never reaches finance. These tables hold integer minor units in the shop's own currency (never converted,
-- never summed with BDT) and NO buyer personal data at all: no name, phone, email or address column exists, and the order
-- upsert keeps only external ids, status, timestamps, SKU lines, money and region.

CREATE TYPE "TikTokConnectionStatus" AS ENUM ('active', 'needs_reconnect', 'permission_error', 'disconnected');
CREATE TYPE "TikTokEventStatus" AS ENUM ('received', 'processed', 'ignored', 'failed');
CREATE TYPE "TikTokStockState" AS ENUM ('none', 'reserved', 'shipped', 'released', 'needs_mapping', 'stock_short');
CREATE TYPE "TikTokSkuLinkSource" AS ENUM ('auto', 'manual');
CREATE TYPE "TikTokHoldState" AS ENUM ('held', 'shipped', 'released');

CREATE TABLE "tiktok_connections" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    -- Shops authorised in one sign-in share ONE token pair; a refresh renews it for all of them together.
    "grant_id" UUID NOT NULL,
    "shop_id" TEXT NOT NULL,
    "shop_cipher" TEXT,
    "shop_name" TEXT NOT NULL,
    "region" TEXT,
    "seller_type" TEXT,
    "currency" TEXT,
    "status" "TikTokConnectionStatus" NOT NULL DEFAULT 'active',
    "mock" BOOLEAN NOT NULL DEFAULT false,
    "access_token_enc" TEXT,
    "refresh_token_enc" TEXT,
    "tokens_obtained_at" TIMESTAMPTZ(3),
    "access_expires_at" TIMESTAMPTZ(3),
    "refresh_expires_at" TIMESTAMPTZ(3),
    "refresh_failures" INTEGER NOT NULL DEFAULT 0,
    "next_refresh_at" TIMESTAMPTZ(3),
    "scopes" JSONB NOT NULL DEFAULT '[]',
    "last_synced_at" TIMESTAMPTZ(3),
    "last_checked_at" TIMESTAMPTZ(3),
    "last_error_code" TEXT,
    "last_error_message" TEXT,
    "connected_by_id" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,
    "disconnected_at" TIMESTAMPTZ(3),

    CONSTRAINT "tiktok_connections_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "tiktok_oauth_sessions" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "state_hash" TEXT NOT NULL,
    "state_used_at" TIMESTAMPTZ(3),
    -- The sealed token pair from the code exchange, until the shops are chosen. Never returned by the API.
    "grant_enc" TEXT,
    -- [{ id, name, region, sellerType }]: names and ids only, no tokens, no cipher.
    "shops" JSONB NOT NULL DEFAULT '[]',
    "reconnect_connection_id" UUID,
    "expires_at" TIMESTAMPTZ(3) NOT NULL,
    "consumed_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "tiktok_oauth_sessions_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "tiktok_events" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "connection_id" UUID NOT NULL,
    -- tts_notification_id, or a deterministic hash of shop id, type, timestamp and order id: the idempotency key of the pipeline.
    "external_event_id" TEXT NOT NULL,
    "event_type" TEXT NOT NULL,
    "order_external_id" TEXT,
    "event_timestamp" TIMESTAMPTZ(3) NOT NULL,
    -- Ids and a status word only. (A MOCK event also carries the synthetic order snapshot: there is no remote to ask.)
    "payload" JSONB NOT NULL DEFAULT '{}',
    "status" "TikTokEventStatus" NOT NULL DEFAULT 'received',
    "error" TEXT,
    "processed_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "tiktok_events_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "tiktok_orders" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "connection_id" UUID NOT NULL,
    "external_order_id" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "on_hold" BOOLEAN NOT NULL DEFAULT false,
    "status_updated_at" TIMESTAMPTZ(3),
    "created_at_tiktok" TIMESTAMPTZ(3),
    "currency" TEXT NOT NULL,
    "currency_exponent" SMALLINT NOT NULL DEFAULT 2,
    "subtotal_minor" BIGINT NOT NULL DEFAULT 0,
    "seller_discount_minor" BIGINT NOT NULL DEFAULT 0,
    "platform_discount_minor" BIGINT NOT NULL DEFAULT 0,
    "shipping_minor" BIGINT NOT NULL DEFAULT 0,
    "tax_minor" BIGINT NOT NULL DEFAULT 0,
    "total_minor" BIGINT NOT NULL DEFAULT 0,
    "fulfilment_type" TEXT,
    "region" TEXT,
    -- [{ key, externalLineId, externalSkuId, sellerSku, productName, quantity, unitPriceMinor }]. The variant a line goes against
    -- is resolved from tiktok_sku_links (and tiktok_stock_holds once stock moved), never copied here.
    "line_items" JSONB NOT NULL DEFAULT '[]',
    "stock_state" "TikTokStockState" NOT NULL DEFAULT 'none',
    "attention" TEXT,
    "mock" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "tiktok_orders_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "tiktok_sku_links" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "connection_id" UUID NOT NULL,
    "external_sku_id" TEXT NOT NULL,
    "seller_sku" TEXT,
    "product_name" TEXT,
    "variant_id" UUID,
    "source" "TikTokSkuLinkSource" NOT NULL DEFAULT 'auto',
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "tiktok_sku_links_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "tiktok_stock_holds" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "tiktok_order_id" UUID NOT NULL,
    "line_key" TEXT NOT NULL,
    "variant_id" UUID NOT NULL,
    "quantity" INTEGER NOT NULL,
    "reservation_id" UUID NOT NULL,
    "state" "TikTokHoldState" NOT NULL DEFAULT 'held',
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "tiktok_stock_holds_pkey" PRIMARY KEY ("id")
);

-- Indexes
CREATE UNIQUE INDEX "tiktok_connections_tenant_id_id_key" ON "tiktok_connections"("tenant_id", "id");
CREATE INDEX "tiktok_connections_tenant_id_status_idx" ON "tiktok_connections"("tenant_id", "status");
CREATE INDEX "tiktok_connections_grant_id_idx" ON "tiktok_connections"("grant_id");
-- A shop belongs to one business at a time: unique across ALL businesses while it is connected.
CREATE UNIQUE INDEX "tiktok_connections_active_shop_key" ON "tiktok_connections"("shop_id") WHERE "status" <> 'disconnected';
CREATE INDEX "tiktok_connections_shop_id_idx" ON "tiktok_connections"("shop_id");

CREATE UNIQUE INDEX "tiktok_oauth_sessions_state_hash_key" ON "tiktok_oauth_sessions"("state_hash");
CREATE UNIQUE INDEX "tiktok_oauth_sessions_tenant_id_id_key" ON "tiktok_oauth_sessions"("tenant_id", "id");

CREATE UNIQUE INDEX "tiktok_events_tenant_id_id_key" ON "tiktok_events"("tenant_id", "id");
CREATE UNIQUE INDEX "tiktok_events_tenant_id_connection_id_external_event_id_key" ON "tiktok_events"("tenant_id", "connection_id", "external_event_id");
CREATE INDEX "tiktok_events_status_created_at_idx" ON "tiktok_events"("status", "created_at");

CREATE UNIQUE INDEX "tiktok_orders_tenant_id_id_key" ON "tiktok_orders"("tenant_id", "id");
CREATE UNIQUE INDEX "tiktok_orders_connection_id_external_order_id_key" ON "tiktok_orders"("connection_id", "external_order_id");
CREATE INDEX "tiktok_orders_tenant_id_status_updated_at_id_idx" ON "tiktok_orders"("tenant_id", "status_updated_at" DESC, "id" DESC);
CREATE INDEX "tiktok_orders_tenant_id_stock_state_idx" ON "tiktok_orders"("tenant_id", "stock_state");
CREATE INDEX "tiktok_orders_updated_at_idx" ON "tiktok_orders"("updated_at");

CREATE UNIQUE INDEX "tiktok_sku_links_tenant_id_id_key" ON "tiktok_sku_links"("tenant_id", "id");
CREATE UNIQUE INDEX "tiktok_sku_links_connection_id_external_sku_id_key" ON "tiktok_sku_links"("connection_id", "external_sku_id");
CREATE INDEX "tiktok_sku_links_tenant_id_variant_id_idx" ON "tiktok_sku_links"("tenant_id", "variant_id");

-- One hold per line of an order: the second barrier behind the order's row lock, so a stock effect can happen only once.
CREATE UNIQUE INDEX "tiktok_stock_holds_tiktok_order_id_line_key_key" ON "tiktok_stock_holds"("tiktok_order_id", "line_key");
CREATE UNIQUE INDEX "tiktok_stock_holds_reservation_id_key" ON "tiktok_stock_holds"("reservation_id");
CREATE INDEX "tiktok_stock_holds_tenant_id_variant_id_idx" ON "tiktok_stock_holds"("tenant_id", "variant_id");

-- Foreign keys
ALTER TABLE "tiktok_connections" ADD CONSTRAINT "tiktok_connections_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "tiktok_connections" ADD CONSTRAINT "tiktok_connections_connected_by_id_fkey" FOREIGN KEY ("connected_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "tiktok_oauth_sessions" ADD CONSTRAINT "tiktok_oauth_sessions_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "tiktok_oauth_sessions" ADD CONSTRAINT "tiktok_oauth_sessions_tenant_id_user_id_fkey" FOREIGN KEY ("tenant_id", "user_id") REFERENCES "memberships"("tenant_id", "user_id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "tiktok_events" ADD CONSTRAINT "tiktok_events_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "tiktok_events" ADD CONSTRAINT "tiktok_events_tenant_id_connection_id_fkey" FOREIGN KEY ("tenant_id", "connection_id") REFERENCES "tiktok_connections"("tenant_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "tiktok_orders" ADD CONSTRAINT "tiktok_orders_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "tiktok_orders" ADD CONSTRAINT "tiktok_orders_tenant_id_connection_id_fkey" FOREIGN KEY ("tenant_id", "connection_id") REFERENCES "tiktok_connections"("tenant_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "tiktok_sku_links" ADD CONSTRAINT "tiktok_sku_links_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "tiktok_sku_links" ADD CONSTRAINT "tiktok_sku_links_tenant_id_connection_id_fkey" FOREIGN KEY ("tenant_id", "connection_id") REFERENCES "tiktok_connections"("tenant_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "tiktok_sku_links" ADD CONSTRAINT "tiktok_sku_links_tenant_id_variant_id_fkey" FOREIGN KEY ("tenant_id", "variant_id") REFERENCES "product_variants"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "tiktok_stock_holds" ADD CONSTRAINT "tiktok_stock_holds_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "tiktok_stock_holds" ADD CONSTRAINT "tiktok_stock_holds_tenant_id_tiktok_order_id_fkey" FOREIGN KEY ("tenant_id", "tiktok_order_id") REFERENCES "tiktok_orders"("tenant_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "tiktok_stock_holds" ADD CONSTRAINT "tiktok_stock_holds_tenant_id_variant_id_fkey" FOREIGN KEY ("tenant_id", "variant_id") REFERENCES "product_variants"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "tiktok_stock_holds" ADD CONSTRAINT "tiktok_stock_holds_reservation_id_fkey" FOREIGN KEY ("reservation_id") REFERENCES "reservations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Checks
ALTER TABLE "tiktok_connections" ADD CONSTRAINT "tiktok_connections_mock_token_check" CHECK (NOT "mock" OR ("access_token_enc" IS NULL AND "refresh_token_enc" IS NULL));
ALTER TABLE "tiktok_connections" ADD CONSTRAINT "tiktok_connections_disconnected_token_check" CHECK ("status" <> 'disconnected' OR ("access_token_enc" IS NULL AND "refresh_token_enc" IS NULL));
ALTER TABLE "tiktok_orders" ADD CONSTRAINT "tiktok_orders_money_check" CHECK ("subtotal_minor" >= 0 AND "seller_discount_minor" >= 0 AND "platform_discount_minor" >= 0 AND "shipping_minor" >= 0 AND "tax_minor" >= 0 AND "total_minor" >= 0);
ALTER TABLE "tiktok_orders" ADD CONSTRAINT "tiktok_orders_attention_check" CHECK ("attention" IS NULL OR "attention" = 'cancelled_after_shipping');
ALTER TABLE "tiktok_orders" ADD CONSTRAINT "tiktok_orders_currency_check" CHECK ("currency" ~ '^[A-Z]{3}$' AND "currency_exponent" BETWEEN 0 AND 3);
ALTER TABLE "tiktok_stock_holds" ADD CONSTRAINT "tiktok_stock_holds_quantity_check" CHECK ("quantity" > 0);

-- ---------------------------------------------------------------------------------------------------------------------
-- Row-level security: confined to the current business, forced like every other tenant table.
-- ---------------------------------------------------------------------------------------------------------------------
ALTER TABLE tiktok_connections    ENABLE ROW LEVEL SECURITY;
ALTER TABLE tiktok_connections    FORCE  ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON tiktok_connections    USING (tenant_id = app_current_tenant()) WITH CHECK (tenant_id = app_current_tenant());
ALTER TABLE tiktok_oauth_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE tiktok_oauth_sessions FORCE  ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON tiktok_oauth_sessions USING (tenant_id = app_current_tenant()) WITH CHECK (tenant_id = app_current_tenant());
ALTER TABLE tiktok_events         ENABLE ROW LEVEL SECURITY;
ALTER TABLE tiktok_events         FORCE  ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON tiktok_events         USING (tenant_id = app_current_tenant()) WITH CHECK (tenant_id = app_current_tenant());
ALTER TABLE tiktok_orders         ENABLE ROW LEVEL SECURITY;
ALTER TABLE tiktok_orders         FORCE  ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON tiktok_orders         USING (tenant_id = app_current_tenant()) WITH CHECK (tenant_id = app_current_tenant());
ALTER TABLE tiktok_sku_links      ENABLE ROW LEVEL SECURITY;
ALTER TABLE tiktok_sku_links      FORCE  ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON tiktok_sku_links      USING (tenant_id = app_current_tenant()) WITH CHECK (tenant_id = app_current_tenant());
ALTER TABLE tiktok_stock_holds    ENABLE ROW LEVEL SECURITY;
ALTER TABLE tiktok_stock_holds    FORCE  ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON tiktok_stock_holds    USING (tenant_id = app_current_tenant()) WITH CHECK (tenant_id = app_current_tenant());

REVOKE TRUNCATE ON tiktok_connections, tiktok_oauth_sessions, tiktok_events, tiktok_orders, tiktok_sku_links, tiktok_stock_holds FROM app_user;

-- ---------------------------------------------------------------------------------------------------------------------
-- Cross-business reads, as narrow SECURITY DEFINER functions (the pattern of the Meta migration): each runs as the owner, which
-- has policies of its own naming it and nobody else (app_user is not the owner and stays fully confined), and returns only
-- what the caller needs.
-- ---------------------------------------------------------------------------------------------------------------------
CREATE POLICY owner_select ON tiktok_connections    FOR SELECT TO CURRENT_USER USING (true);
CREATE POLICY owner_select ON tiktok_events         FOR SELECT TO CURRENT_USER USING (true);
CREATE POLICY owner_delete ON tiktok_events         FOR DELETE TO CURRENT_USER USING (true);
CREATE POLICY owner_select ON tiktok_orders         FOR SELECT TO CURRENT_USER USING (true);
CREATE POLICY owner_delete ON tiktok_orders         FOR DELETE TO CURRENT_USER USING (true);
CREATE POLICY owner_select ON tiktok_stock_holds    FOR SELECT TO CURRENT_USER USING (true);
CREATE POLICY owner_delete ON tiktok_stock_holds    FOR DELETE TO CURRENT_USER USING (true);
CREATE POLICY owner_select ON tiktok_oauth_sessions FOR SELECT TO CURRENT_USER USING (true);
CREATE POLICY owner_delete ON tiktok_oauth_sessions FOR DELETE TO CURRENT_USER USING (true);

-- 1. The webhook's ONLY cross-business read: which connection (and business) owns this TikTok shop id. A connected shop wins
-- over an old disconnected one; a disconnected-only shop is returned so its events can be recorded as ignored.
CREATE FUNCTION tiktok_connection_for(p_shop_id text)
RETURNS TABLE (id uuid, tenant_id uuid, status "TikTokConnectionStatus")
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
  SELECT c.id, c.tenant_id, c.status
  FROM tiktok_connections c
  WHERE c.shop_id = p_shop_id
  ORDER BY (c.status = 'disconnected'), c.created_at DESC, c.id DESC
  LIMIT 1
$$;
REVOKE ALL ON FUNCTION tiktok_connection_for(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION tiktok_connection_for(text) TO app_user;

-- 2. Events saved but never queued (the API died or Redis was down): 'received' for a while.
CREATE FUNCTION stale_received_tiktok_events(older_than_seconds integer, max_rows integer DEFAULT 200)
RETURNS TABLE (id uuid, tenant_id uuid)
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
  SELECT e.id, e.tenant_id
  FROM tiktok_events e
  WHERE e.status = 'received' AND e.created_at < now() - make_interval(secs => GREATEST(older_than_seconds, 30))
  ORDER BY e.created_at
  LIMIT LEAST(GREATEST(max_rows, 1), 1000)
$$;
REVOKE ALL ON FUNCTION stale_received_tiktok_events(integer, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION stale_received_tiktok_events(integer, integer) TO app_user;

-- 3. The health check and the catch-up poll: connections that talk to the real TikTok (not mock) and can still work or recover.
CREATE FUNCTION live_tiktok_connections(after_id uuid, max_rows integer DEFAULT 200)
RETURNS TABLE (id uuid, tenant_id uuid)
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
  SELECT c.id, c.tenant_id
  FROM tiktok_connections c
  WHERE NOT c.mock AND c.status IN ('active', 'permission_error') AND (after_id IS NULL OR c.id > after_id)
  ORDER BY c.id
  LIMIT LEAST(GREATEST(max_rows, 1), 1000)
$$;
REVOKE ALL ON FUNCTION live_tiktok_connections(uuid, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION live_tiktok_connections(uuid, integer) TO app_user;

-- 4. The token-refresh scan: one connection per grant (shops authorised together share a token pair) whose tokens might be inside
-- their renewal window. A loose 24 h pre-filter; the caller applies the exact rule (half the lifetime). Connections that failed
-- recently wait for next_refresh_at.
CREATE FUNCTION tiktok_connections_due_for_refresh(max_rows integer DEFAULT 200)
RETURNS TABLE (id uuid, tenant_id uuid, tokens_obtained_at timestamptz, access_expires_at timestamptz, refresh_expires_at timestamptz)
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
  SELECT DISTINCT ON (c.grant_id) c.id, c.tenant_id, c.tokens_obtained_at, c.access_expires_at, c.refresh_expires_at
  FROM tiktok_connections c
  WHERE NOT c.mock AND c.status IN ('active', 'permission_error') AND c.refresh_token_enc IS NOT NULL
    AND (c.next_refresh_at IS NULL OR c.next_refresh_at <= now())
    AND (c.access_expires_at IS NULL OR c.access_expires_at < now() + interval '24 hours'
         OR c.refresh_expires_at < now() + interval '24 hours')
  ORDER BY c.grant_id, c.created_at, c.id
  LIMIT LEAST(GREATEST(max_rows, 1), 1000)
$$;
REVOKE ALL ON FUNCTION tiktok_connections_due_for_refresh(integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION tiktok_connections_due_for_refresh(integer) TO app_user;

-- 5. Retention (worker), across businesses: webhook events older than event_days (kept while still `received`); mirrored orders
-- older than order_days that are in a final state and hold no live reservation (their SKU lines and holds go with them); expired
-- sign-in hand-overs (which hold a sealed token pair) a day after they expire.
CREATE FUNCTION purge_tiktok_data(event_days integer, order_days integer)
RETURNS TABLE (events integer, orders integer, sessions integer)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  event_cutoff timestamptz := now() - make_interval(days => GREATEST(event_days, 1));
  order_cutoff timestamptz := now() - make_interval(days => GREATEST(order_days, 30));
  n_events integer; n_orders integer; n_sessions integer;
BEGIN
  WITH gone AS (
    DELETE FROM tiktok_events e WHERE e.created_at < event_cutoff AND e.status <> 'received' RETURNING 1)
  SELECT count(*)::integer INTO n_events FROM gone;
  WITH gone AS (
    DELETE FROM tiktok_orders o
    WHERE o.updated_at < order_cutoff
      AND upper(o.status) IN ('COMPLETED', 'CANCELLED', 'DELIVERED')
      AND NOT EXISTS (SELECT 1 FROM tiktok_stock_holds h WHERE h.tiktok_order_id = o.id AND h.state = 'held')
    RETURNING 1)
  SELECT count(*)::integer INTO n_orders FROM gone;
  WITH gone AS (
    DELETE FROM tiktok_oauth_sessions s WHERE s.expires_at < now() - interval '1 day' RETURNING 1)
  SELECT count(*)::integer INTO n_sessions FROM gone;
  RETURN QUERY SELECT n_events, n_orders, n_sessions;
END
$$;
REVOKE ALL ON FUNCTION purge_tiktok_data(integer, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION purge_tiktok_data(integer, integer) TO app_user;

-- ---------------------------------------------------------------------------------------------------------------------
-- The business purge (20261031100000_data_deletion) lists every tenant table, children first: the same function again with the
-- TikTok tables added before the stock tables they refer to. Privileges are kept by CREATE OR REPLACE.
-- ---------------------------------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION purge_tenant(p_tenant uuid)
RETURNS TABLE (purged boolean, rows_deleted integer, counts jsonb, user_anonymised boolean)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  requested_by uuid;
  tbl text;
  n integer;
  total integer := 0;
  per jsonb := '{}'::jsonb;
  anonymised boolean := false;
  -- Order matters: every table appears before the tables it references.
  tables text[] := ARRAY[
    'notification_deliveries', 'notifications', 'notification_preferences', 'messaging_consents',
    'social_oauth_sessions', 'social_drafts', 'social_events', 'social_connections',
    'tiktok_stock_holds', 'tiktok_sku_links', 'tiktok_orders', 'tiktok_events', 'tiktok_oauth_sessions', 'tiktok_connections',
    'automation_state', 'automation_runs', 'automation_rules',
    'settlement_item_events', 'discrepancies', 'settlement_items', 'settlement_batches',
    'manual_costs', 'shipment_events', 'shipments', 'courier_connections',
    'order_status_history', 'order_items', 'order_counters', 'orders', 'customer_addresses', 'customers',
    'stock_movements', 'reservations', 'stock_levels', 'product_variants', 'products', 'suppliers', 'categories',
    'stock_locations', 'import_jobs', 'idempotency_keys', 'invitations', 'memberships', 'audit_logs'];
BEGIN
  -- Fence the session to this business, as the API would, so row-level security lets the deletes through (and only these).
  PERFORM set_config('app.tenant_id', p_tenant::text, true);
  SELECT t.deletion_requested_by_id INTO requested_by
    FROM tenants t
   WHERE t.id = p_tenant AND t.purge_after IS NOT NULL AND t.purge_after <= now()
   FOR UPDATE;
  IF NOT FOUND THEN
    PERFORM set_config('app.tenant_id', '', true);
    RETURN QUERY SELECT false, 0, '{}'::jsonb, false;
    RETURN;
  END IF;

  FOREACH tbl IN ARRAY tables LOOP
    EXECUTE format('DELETE FROM %I WHERE tenant_id = $1', tbl) USING p_tenant;
    GET DIAGNOSTICS n = ROW_COUNT;
    total := total + n;
    IF n > 0 THEN per := per || jsonb_build_object(tbl, n); END IF;
  END LOOP;
  -- A stored answer to "create a business" belongs to the person, not the business, and names it.
  DELETE FROM idempotency_keys
   WHERE tenant_id IS NULL AND response_body ->> 'id' = p_tenant::text AND created_at < now() - interval '1 hour';
  DELETE FROM sessions WHERE active_tenant_id = p_tenant;
  DELETE FROM tenants WHERE id = p_tenant;
  total := total + 1;

  IF requested_by IS NOT NULL THEN
    PERFORM set_config('app.user_id', requested_by::text, true);
    IF NOT EXISTS (SELECT 1 FROM memberships WHERE user_id = requested_by)
       AND EXISTS (SELECT 1 FROM users WHERE id = requested_by AND deleted_at IS NULL) THEN
      PERFORM _anonymise_user(requested_by);
      anonymised := true;
    END IF;
  END IF;

  -- The business's own audit trail went with it; one tenant-less line (ids and numbers only) records that it happened.
  PERFORM set_config('app.tenant_id', '', true);
  INSERT INTO audit_logs (id, tenant_id, actor_user_id, action, target_type, target_id, metadata)
  VALUES (gen_random_uuid(), NULL, requested_by, 'tenant.purged', 'tenant', p_tenant::text,
          jsonb_build_object('rows', total, 'userAnonymised', anonymised));
  PERFORM set_config('app.user_id', '', true);
  RETURN QUERY SELECT true, total, per, anonymised;
END
$$;
