-- Meta (Facebook Page Messenger + Instagram DM) receive-only integration: connections, the OAuth hand-over, the webhook event
-- log, and review drafts. Messages sent TO a seller's business become DRAFT orders that a person confirms. See docs/meta.md.

-- CreateEnum
CREATE TYPE "SocialProvider" AS ENUM ('facebook_page', 'instagram');
CREATE TYPE "SocialConnectionStatus" AS ENUM ('active', 'needs_reconnect', 'permission_error', 'disconnected');
CREATE TYPE "SocialEventStatus" AS ENUM ('received', 'processed', 'ignored', 'failed');
CREATE TYPE "SocialDraftStatus" AS ENUM ('needs_review', 'confirmed', 'dismissed');

-- CreateTable
CREATE TABLE "social_connections" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "provider" "SocialProvider" NOT NULL,
    "external_id" TEXT NOT NULL,
    "display_name" TEXT NOT NULL,
    "username" TEXT,
    "linked_page_id" TEXT,
    "status" "SocialConnectionStatus" NOT NULL DEFAULT 'active',
    "mock" BOOLEAN NOT NULL DEFAULT false,
    "access_token_enc" TEXT,
    "token_type" TEXT,
    "token_expires_at" TIMESTAMPTZ(3),
    "scopes" JSONB NOT NULL DEFAULT '[]',
    "meta_user_id" TEXT,
    "last_checked_at" TIMESTAMPTZ(3),
    "last_error_code" TEXT,
    "last_error_message" TEXT,
    "connected_by_id" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,
    "disconnected_at" TIMESTAMPTZ(3),

    CONSTRAINT "social_connections_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "social_oauth_sessions" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "state_hash" TEXT NOT NULL,
    "state_used_at" TIMESTAMPTZ(3),
    "user_token_enc" TEXT,
    "meta_user_id" TEXT,
    "pages" JSONB NOT NULL DEFAULT '[]',
    "reconnect_connection_id" UUID,
    "expires_at" TIMESTAMPTZ(3) NOT NULL,
    "consumed_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "social_oauth_sessions_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "social_events" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "connection_id" UUID NOT NULL,
    "provider" "SocialProvider" NOT NULL,
    "external_event_id" TEXT NOT NULL,
    "sender_id" TEXT NOT NULL,
    "event_type" TEXT NOT NULL,
    "event_timestamp" TIMESTAMPTZ(3) NOT NULL,
    "payload" JSONB NOT NULL DEFAULT '{}',
    "status" "SocialEventStatus" NOT NULL DEFAULT 'received',
    "error" TEXT,
    "processed_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "social_events_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "social_drafts" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "connection_id" UUID NOT NULL,
    "sender_id" TEXT NOT NULL,
    "status" "SocialDraftStatus" NOT NULL DEFAULT 'needs_review',
    "extracted" JSONB NOT NULL DEFAULT '{}',
    "overrides" JSONB NOT NULL DEFAULT '{}',
    "source_event_ids" JSONB NOT NULL DEFAULT '[]',
    "first_message_at" TIMESTAMPTZ(3) NOT NULL,
    "last_message_at" TIMESTAMPTZ(3) NOT NULL,
    "order_id" UUID,
    "dismissed_reason" TEXT,
    "reviewed_by_id" UUID,
    "reviewed_at" TIMESTAMPTZ(3),
    "mock" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "social_drafts_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "social_connections_tenant_id_id_key" ON "social_connections"("tenant_id", "id");
CREATE INDEX "social_connections_tenant_id_status_idx" ON "social_connections"("tenant_id", "status");
-- An account belongs to one business at a time: unique across ALL businesses while it is connected.
CREATE UNIQUE INDEX "social_connections_active_account_key" ON "social_connections"("provider", "external_id") WHERE "status" <> 'disconnected';
CREATE INDEX "social_connections_meta_user_id_idx" ON "social_connections"("meta_user_id") WHERE "meta_user_id" IS NOT NULL;

CREATE UNIQUE INDEX "social_oauth_sessions_state_hash_key" ON "social_oauth_sessions"("state_hash");
CREATE UNIQUE INDEX "social_oauth_sessions_tenant_id_id_key" ON "social_oauth_sessions"("tenant_id", "id");

CREATE UNIQUE INDEX "social_events_tenant_id_id_key" ON "social_events"("tenant_id", "id");
CREATE UNIQUE INDEX "social_events_tenant_id_connection_id_external_event_id_key" ON "social_events"("tenant_id", "connection_id", "external_event_id");
CREATE INDEX "social_events_status_created_at_idx" ON "social_events"("status", "created_at");
CREATE INDEX "social_events_tenant_id_connection_id_sender_id_event_times_idx" ON "social_events"("tenant_id", "connection_id", "sender_id", "event_timestamp");

CREATE UNIQUE INDEX "social_drafts_tenant_id_id_key" ON "social_drafts"("tenant_id", "id");
CREATE INDEX "social_drafts_tenant_id_status_last_message_at_id_idx" ON "social_drafts"("tenant_id", "status", "last_message_at" DESC, "id" DESC);
-- One OPEN draft per conversation: later messages append to it.
CREATE UNIQUE INDEX "social_drafts_one_open_per_sender" ON "social_drafts"("connection_id", "sender_id") WHERE "status" = 'needs_review';
CREATE UNIQUE INDEX "social_drafts_order_id_key" ON "social_drafts"("order_id") WHERE "order_id" IS NOT NULL;

-- AddForeignKey
ALTER TABLE "social_connections" ADD CONSTRAINT "social_connections_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "social_connections" ADD CONSTRAINT "social_connections_connected_by_id_fkey" FOREIGN KEY ("connected_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "social_oauth_sessions" ADD CONSTRAINT "social_oauth_sessions_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "social_oauth_sessions" ADD CONSTRAINT "social_oauth_sessions_tenant_id_user_id_fkey" FOREIGN KEY ("tenant_id", "user_id") REFERENCES "memberships"("tenant_id", "user_id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "social_events" ADD CONSTRAINT "social_events_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "social_events" ADD CONSTRAINT "social_events_tenant_id_connection_id_fkey" FOREIGN KEY ("tenant_id", "connection_id") REFERENCES "social_connections"("tenant_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "social_drafts" ADD CONSTRAINT "social_drafts_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "social_drafts" ADD CONSTRAINT "social_drafts_tenant_id_connection_id_fkey" FOREIGN KEY ("tenant_id", "connection_id") REFERENCES "social_connections"("tenant_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "social_drafts" ADD CONSTRAINT "social_drafts_tenant_id_order_id_fkey" FOREIGN KEY ("tenant_id", "order_id") REFERENCES "orders"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- A confirmed draft has its order; nothing else does.
ALTER TABLE "social_drafts" ADD CONSTRAINT "social_drafts_confirmed_order_check" CHECK (("status" = 'confirmed') = ("order_id" IS NOT NULL));
-- A mock connection never holds a token.
ALTER TABLE "social_connections" ADD CONSTRAINT "social_connections_mock_token_check" CHECK (NOT "mock" OR "access_token_enc" IS NULL);

-- ---------------------------------------------------------------------------------------------------------------------
-- Row-level security: confined to the current business, forced like every other tenant table.
-- ---------------------------------------------------------------------------------------------------------------------
ALTER TABLE social_connections    ENABLE ROW LEVEL SECURITY;
ALTER TABLE social_connections    FORCE  ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON social_connections    USING (tenant_id = app_current_tenant()) WITH CHECK (tenant_id = app_current_tenant());
ALTER TABLE social_oauth_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE social_oauth_sessions FORCE  ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON social_oauth_sessions USING (tenant_id = app_current_tenant()) WITH CHECK (tenant_id = app_current_tenant());
ALTER TABLE social_events         ENABLE ROW LEVEL SECURITY;
ALTER TABLE social_events         FORCE  ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON social_events         USING (tenant_id = app_current_tenant()) WITH CHECK (tenant_id = app_current_tenant());
ALTER TABLE social_drafts         ENABLE ROW LEVEL SECURITY;
ALTER TABLE social_drafts         FORCE  ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON social_drafts         USING (tenant_id = app_current_tenant()) WITH CHECK (tenant_id = app_current_tenant());

REVOKE TRUNCATE ON social_connections, social_oauth_sessions, social_events, social_drafts FROM app_user;

-- ---------------------------------------------------------------------------------------------------------------------
-- Cross-business reads, as narrow SECURITY DEFINER functions (the pattern of stale_pending_imports): each runs as the owner,
-- which has policies of its own naming it and nobody else (app_user is not the owner and stays fully confined), and returns
-- only what the caller needs.
-- ---------------------------------------------------------------------------------------------------------------------
CREATE POLICY owner_select ON social_connections FOR SELECT TO CURRENT_USER USING (true);
CREATE POLICY owner_select ON social_events      FOR SELECT TO CURRENT_USER USING (true);
CREATE POLICY owner_select ON social_drafts      FOR SELECT TO CURRENT_USER USING (true);
CREATE POLICY owner_delete ON social_events      FOR DELETE TO CURRENT_USER USING (true);
CREATE POLICY owner_delete ON social_drafts      FOR DELETE TO CURRENT_USER USING (true);
CREATE POLICY owner_select ON social_oauth_sessions FOR SELECT TO CURRENT_USER USING (true);
CREATE POLICY owner_delete ON social_oauth_sessions FOR DELETE TO CURRENT_USER USING (true);

-- 1. The webhook's ONLY cross-business read: which connection (and business) owns this Page / Instagram account id.
CREATE FUNCTION meta_connection_for(p_provider "SocialProvider", p_external_id text)
RETURNS TABLE (id uuid, tenant_id uuid, status "SocialConnectionStatus")
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
  SELECT c.id, c.tenant_id, c.status
  FROM social_connections c
  WHERE c.provider = p_provider AND c.external_id = p_external_id AND c.status <> 'disconnected'
  LIMIT 1
$$;
REVOKE ALL ON FUNCTION meta_connection_for("SocialProvider", text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION meta_connection_for("SocialProvider", text) TO app_user;

-- 2. Events saved but never queued (the API died or Redis was down): 'received' for a while.
CREATE FUNCTION stale_received_social_events(older_than_seconds integer, max_rows integer DEFAULT 200)
RETURNS TABLE (id uuid, tenant_id uuid)
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
  SELECT e.id, e.tenant_id
  FROM social_events e
  WHERE e.status = 'received' AND e.created_at < now() - make_interval(secs => GREATEST(older_than_seconds, 30))
  ORDER BY e.created_at
  LIMIT LEAST(GREATEST(max_rows, 1), 1000)
$$;
REVOKE ALL ON FUNCTION stale_received_social_events(integer, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION stale_received_social_events(integer, integer) TO app_user;

-- 3. The daily health check: connections that talk to the real Meta (not mock) and can still work or recover.
CREATE FUNCTION live_social_connections(after_id uuid, max_rows integer DEFAULT 200)
RETURNS TABLE (id uuid, tenant_id uuid)
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
  SELECT c.id, c.tenant_id
  FROM social_connections c
  WHERE NOT c.mock AND c.status IN ('active', 'permission_error') AND (after_id IS NULL OR c.id > after_id)
  ORDER BY c.id
  LIMIT LEAST(GREATEST(max_rows, 1), 1000)
$$;
REVOKE ALL ON FUNCTION live_social_connections(uuid, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION live_social_connections(uuid, integer) TO app_user;

-- 4. Deauthorize / data-deletion callbacks: which connections belong to the person who authorised (meta_user_id), and which
-- connections hold conversations with a customer id (sender_id), whichever business they are in.
CREATE FUNCTION meta_deletion_targets(p_subject text)
RETURNS TABLE (tenant_id uuid, connection_id uuid, reason text)
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
  SELECT c.tenant_id, c.id, 'authoriser'::text FROM social_connections c WHERE c.meta_user_id = p_subject
  UNION
  SELECT e.tenant_id, e.connection_id, 'sender'::text FROM social_events e WHERE e.sender_id = p_subject
  UNION
  SELECT d.tenant_id, d.connection_id, 'sender'::text FROM social_drafts d WHERE d.sender_id = p_subject
$$;
REVOKE ALL ON FUNCTION meta_deletion_targets(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION meta_deletion_targets(text) TO app_user;

-- 5. Retention (worker): drafts nobody confirmed, dismissed or confirmed drafts, and events older than the cutoff, across
-- businesses. An event of a conversation that still has an OPEN draft stays until that draft goes. Expired OAuth hand-overs
-- (which hold a sealed user token) go a day after they expire.
CREATE FUNCTION purge_social_data(retention_days integer)
RETURNS TABLE (drafts integer, events integer, sessions integer)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  cutoff timestamptz := now() - make_interval(days => GREATEST(retention_days, 1));
  n_drafts integer; n_events integer; n_sessions integer;
BEGIN
  WITH gone AS (
    DELETE FROM social_drafts d
    WHERE (d.status = 'needs_review' AND d.last_message_at < cutoff)
       OR (d.status <> 'needs_review' AND d.updated_at < cutoff)
    RETURNING 1)
  SELECT count(*)::integer INTO n_drafts FROM gone;
  WITH gone AS (
    DELETE FROM social_events e
    WHERE e.created_at < cutoff
      AND e.status <> 'received'
      AND NOT EXISTS (SELECT 1 FROM social_drafts d
                      WHERE d.connection_id = e.connection_id AND d.sender_id = e.sender_id AND d.status = 'needs_review')
    RETURNING 1)
  SELECT count(*)::integer INTO n_events FROM gone;
  WITH gone AS (
    DELETE FROM social_oauth_sessions s WHERE s.expires_at < now() - interval '1 day' RETURNING 1)
  SELECT count(*)::integer INTO n_sessions FROM gone;
  RETURN QUERY SELECT n_drafts, n_events, n_sessions;
END
$$;
REVOKE ALL ON FUNCTION purge_social_data(integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION purge_social_data(integer) TO app_user;
