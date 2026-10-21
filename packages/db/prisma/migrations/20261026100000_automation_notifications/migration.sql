-- Automation and notifications: rules, runs (idempotent scheduling slots), episode state, notifications, preferences, deliveries,
-- push devices, messaging consents. See docs/automation.md.

-- CreateEnum
CREATE TYPE "AutomationKind" AS ENUM ('LOW_STOCK', 'NEW_ORDER', 'UNCONFIRMED_ORDER', 'DELAYED_ORDER', 'COD_DISCREPANCY', 'DAILY_REPORT', 'WEEKLY_REPORT');

-- CreateEnum
CREATE TYPE "NotificationChannel" AS ENUM ('in_app', 'push', 'email', 'sms', 'whatsapp');

-- CreateEnum
CREATE TYPE "DeliveryStatus" AS ENUM ('pending', 'sent', 'failed', 'skipped');

-- CreateEnum
CREATE TYPE "AutomationRunStatus" AS ENUM ('queued', 'running', 'succeeded', 'failed', 'skipped');

-- CreateEnum
CREATE TYPE "AutomationTrigger" AS ENUM ('scheduled', 'event', 'manual', 'retry');

-- CreateEnum
CREATE TYPE "PushPlatform" AS ENUM ('ios', 'android');

-- CreateEnum
CREATE TYPE "PushProviderKind" AS ENUM ('expo', 'dev');

-- CreateEnum
CREATE TYPE "MessagingChannel" AS ENUM ('sms', 'whatsapp');

-- CreateTable
CREATE TABLE "automation_rules" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "kind" "AutomationKind" NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "config" JSONB NOT NULL DEFAULT '{}',
    "channels" JSONB NOT NULL DEFAULT '{}',
    "enabled_at" TIMESTAMPTZ(3),
    "updated_by_id" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "automation_rules_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "automation_runs" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "rule_id" UUID NOT NULL,
    "kind" "AutomationKind" NOT NULL,
    "slot_key" TEXT NOT NULL,
    "trigger" "AutomationTrigger" NOT NULL,
    "scheduled_for" TIMESTAMPTZ(3) NOT NULL,
    "status" "AutomationRunStatus" NOT NULL DEFAULT 'queued',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "error" TEXT,
    "created_count" INTEGER NOT NULL DEFAULT 0,
    "skipped_count" INTEGER NOT NULL DEFAULT 0,
    "started_at" TIMESTAMPTZ(3),
    "finished_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "automation_runs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "automation_state" (
    "tenant_id" UUID NOT NULL,
    "rule_id" UUID NOT NULL,
    "subject_id" TEXT NOT NULL,
    "count" INTEGER NOT NULL DEFAULT 1,
    "last_notified_at" TIMESTAMPTZ(3) NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "automation_state_pkey" PRIMARY KEY ("rule_id","subject_id")
);

-- CreateTable
CREATE TABLE "notifications" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "run_id" UUID,
    "kind" "AutomationKind" NOT NULL,
    "title" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "data" JSONB NOT NULL DEFAULT '{}',
    "dedupe_key" TEXT NOT NULL,
    "in_app" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "read_at" TIMESTAMPTZ(3),

    CONSTRAINT "notifications_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "notification_preferences" (
    "tenant_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "kind" "AutomationKind" NOT NULL,
    "in_app" BOOLEAN NOT NULL DEFAULT true,
    "push" BOOLEAN NOT NULL DEFAULT true,
    "email" BOOLEAN NOT NULL DEFAULT false,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "notification_preferences_pkey" PRIMARY KEY ("tenant_id","user_id","kind")
);

-- CreateTable
CREATE TABLE "notification_deliveries" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "notification_id" UUID NOT NULL,
    "channel" "NotificationChannel" NOT NULL,
    "status" "DeliveryStatus" NOT NULL DEFAULT 'pending',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "last_error" TEXT,
    "claimed_at" TIMESTAMPTZ(3),
    "sent_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "notification_deliveries_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "push_devices" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "token" TEXT NOT NULL,
    "platform" "PushPlatform" NOT NULL,
    "provider" "PushProviderKind" NOT NULL,
    "last_seen_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "push_devices_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "messaging_consents" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "channel" "MessagingChannel" NOT NULL,
    "phone" TEXT NOT NULL,
    "granted_at" TIMESTAMPTZ(3) NOT NULL,
    "revoked_at" TIMESTAMPTZ(3),
    "source" TEXT NOT NULL,

    CONSTRAINT "messaging_consents_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "automation_rules_tenant_id_id_key" ON "automation_rules"("tenant_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "automation_rules_tenant_id_kind_key" ON "automation_rules"("tenant_id", "kind");

-- CreateIndex
CREATE INDEX "automation_runs_tenant_id_created_at_idx" ON "automation_runs"("tenant_id", "created_at");

-- CreateIndex
CREATE INDEX "automation_runs_tenant_id_status_created_at_idx" ON "automation_runs"("tenant_id", "status", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "automation_runs_tenant_id_id_key" ON "automation_runs"("tenant_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "automation_runs_rule_id_slot_key_key" ON "automation_runs"("rule_id", "slot_key");

-- CreateIndex
CREATE INDEX "automation_state_tenant_id_rule_id_idx" ON "automation_state"("tenant_id", "rule_id");

-- CreateIndex
CREATE INDEX "notifications_tenant_id_user_id_created_at_id_idx" ON "notifications"("tenant_id", "user_id", "created_at" DESC, "id" DESC);

-- CreateIndex
CREATE INDEX "notifications_tenant_id_run_id_idx" ON "notifications"("tenant_id", "run_id");

-- CreateIndex
CREATE UNIQUE INDEX "notifications_tenant_id_id_key" ON "notifications"("tenant_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "notifications_tenant_id_user_id_dedupe_key_key" ON "notifications"("tenant_id", "user_id", "dedupe_key");

-- CreateIndex
CREATE INDEX "notification_deliveries_tenant_id_status_created_at_idx" ON "notification_deliveries"("tenant_id", "status", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "notification_deliveries_tenant_id_id_key" ON "notification_deliveries"("tenant_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "notification_deliveries_notification_id_channel_key" ON "notification_deliveries"("notification_id", "channel");

-- CreateIndex
CREATE UNIQUE INDEX "push_devices_token_key" ON "push_devices"("token");

-- CreateIndex
CREATE INDEX "push_devices_user_id_idx" ON "push_devices"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "messaging_consents_tenant_id_user_id_channel_key" ON "messaging_consents"("tenant_id", "user_id", "channel");

-- AddForeignKey
ALTER TABLE "automation_rules" ADD CONSTRAINT "automation_rules_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "automation_runs" ADD CONSTRAINT "automation_runs_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "automation_runs" ADD CONSTRAINT "automation_runs_tenant_id_rule_id_fkey" FOREIGN KEY ("tenant_id", "rule_id") REFERENCES "automation_rules"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "automation_state" ADD CONSTRAINT "automation_state_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "automation_state" ADD CONSTRAINT "automation_state_tenant_id_rule_id_fkey" FOREIGN KEY ("tenant_id", "rule_id") REFERENCES "automation_rules"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_tenant_id_user_id_fkey" FOREIGN KEY ("tenant_id", "user_id") REFERENCES "memberships"("tenant_id", "user_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_tenant_id_run_id_fkey" FOREIGN KEY ("tenant_id", "run_id") REFERENCES "automation_runs"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notification_preferences" ADD CONSTRAINT "notification_preferences_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notification_preferences" ADD CONSTRAINT "notification_preferences_tenant_id_user_id_fkey" FOREIGN KEY ("tenant_id", "user_id") REFERENCES "memberships"("tenant_id", "user_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notification_deliveries" ADD CONSTRAINT "notification_deliveries_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notification_deliveries" ADD CONSTRAINT "notification_deliveries_tenant_id_notification_id_fkey" FOREIGN KEY ("tenant_id", "notification_id") REFERENCES "notifications"("tenant_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "push_devices" ADD CONSTRAINT "push_devices_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "messaging_consents" ADD CONSTRAINT "messaging_consents_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "messaging_consents" ADD CONSTRAINT "messaging_consents_tenant_id_user_id_fkey" FOREIGN KEY ("tenant_id", "user_id") REFERENCES "memberships"("tenant_id", "user_id") ON DELETE CASCADE ON UPDATE CASCADE;


-- Sanity checks the schema language cannot express.
ALTER TABLE "automation_runs" ADD CONSTRAINT "automation_runs_attempts_check" CHECK ("attempts" >= 0 AND "created_count" >= 0 AND "skipped_count" >= 0);
ALTER TABLE "automation_state" ADD CONSTRAINT "automation_state_count_check" CHECK ("count" >= 1);
ALTER TABLE "notification_deliveries" ADD CONSTRAINT "notification_deliveries_attempts_check" CHECK ("attempts" >= 0);
-- a sent delivery has a send time; a pending one never does
ALTER TABLE "notification_deliveries" ADD CONSTRAINT "notification_deliveries_sent_at_check" CHECK (("status" = 'sent') = ("sent_at" IS NOT NULL));

-- ---------------------------------------------------------------------------------------------------------------------
-- Row-level security: every table with a tenant_id is confined to the current business, forced like the rest.
-- ---------------------------------------------------------------------------------------------------------------------
ALTER TABLE automation_rules         ENABLE ROW LEVEL SECURITY;
ALTER TABLE automation_rules         FORCE  ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON automation_rules         USING (tenant_id = app_current_tenant()) WITH CHECK (tenant_id = app_current_tenant());
ALTER TABLE automation_runs          ENABLE ROW LEVEL SECURITY;
ALTER TABLE automation_runs          FORCE  ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON automation_runs          USING (tenant_id = app_current_tenant()) WITH CHECK (tenant_id = app_current_tenant());
ALTER TABLE automation_state         ENABLE ROW LEVEL SECURITY;
ALTER TABLE automation_state         FORCE  ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON automation_state         USING (tenant_id = app_current_tenant()) WITH CHECK (tenant_id = app_current_tenant());
ALTER TABLE notifications            ENABLE ROW LEVEL SECURITY;
ALTER TABLE notifications            FORCE  ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON notifications            USING (tenant_id = app_current_tenant()) WITH CHECK (tenant_id = app_current_tenant());
ALTER TABLE notification_preferences ENABLE ROW LEVEL SECURITY;
ALTER TABLE notification_preferences FORCE  ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON notification_preferences USING (tenant_id = app_current_tenant()) WITH CHECK (tenant_id = app_current_tenant());
ALTER TABLE notification_deliveries  ENABLE ROW LEVEL SECURITY;
ALTER TABLE notification_deliveries  FORCE  ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON notification_deliveries  USING (tenant_id = app_current_tenant()) WITH CHECK (tenant_id = app_current_tenant());
ALTER TABLE messaging_consents       ENABLE ROW LEVEL SECURITY;
ALTER TABLE messaging_consents       FORCE  ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON messaging_consents       USING (tenant_id = app_current_tenant()) WITH CHECK (tenant_id = app_current_tenant());

-- History stays: rules, runs, notifications, deliveries, preferences and consents are never deleted by the application (a
-- consent is revoked, not removed). Only episode state, which re-arms by deletion, may be deleted.
REVOKE DELETE, TRUNCATE ON automation_rules, automation_runs, notifications, notification_preferences, notification_deliveries, messaging_consents FROM app_user;

-- ---------------------------------------------------------------------------------------------------------------------
-- push_devices: a person's phone, not a business's data, so no tenant_id. A user reads and changes only their own rows; inside
-- a business's context the worker may also READ the devices of that business's members (to send them a push). Row-level
-- security is enabled but not forced: the two SECURITY DEFINER functions below run as the owner and are the only way to move
-- a token from one person to another or to drop a dead one.
-- ---------------------------------------------------------------------------------------------------------------------
ALTER TABLE push_devices ENABLE ROW LEVEL SECURITY;
CREATE POLICY push_devices_select ON push_devices FOR SELECT
  USING (user_id = app_current_user()
         OR EXISTS (SELECT 1 FROM memberships m WHERE m.tenant_id = app_current_tenant() AND m.user_id = push_devices.user_id));
CREATE POLICY push_devices_insert ON push_devices FOR INSERT WITH CHECK (user_id = app_current_user());
CREATE POLICY push_devices_update ON push_devices FOR UPDATE USING (user_id = app_current_user()) WITH CHECK (user_id = app_current_user());
CREATE POLICY push_devices_delete ON push_devices FOR DELETE USING (user_id = app_current_user());
REVOKE TRUNCATE ON push_devices FROM app_user;

-- Registering is an upsert by token. If the token belonged to someone else (a phone handed over, a second account on one
-- phone) it moves to the caller, which a row-level policy alone would forbid. Only for the caller's own id.
CREATE FUNCTION upsert_push_device(p_user_id uuid, p_token text, p_platform "PushPlatform", p_provider "PushProviderKind")
RETURNS TABLE (id uuid, platform "PushPlatform", provider "PushProviderKind", last_seen_at timestamptz)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
  IF p_user_id IS NULL OR p_user_id IS DISTINCT FROM app_current_user() THEN
    RAISE EXCEPTION 'upsert_push_device: not the current user' USING ERRCODE = '42501';
  END IF;
  RETURN QUERY
  INSERT INTO push_devices AS d (id, user_id, token, platform, provider, last_seen_at)
  VALUES (gen_random_uuid(), p_user_id, p_token, p_platform, p_provider, now())
  ON CONFLICT (token) DO UPDATE
    SET user_id = EXCLUDED.user_id, platform = EXCLUDED.platform, provider = EXCLUDED.provider, last_seen_at = now()
  RETURNING d.id, d.platform, d.provider, d.last_seen_at;
END
$$;
REVOKE ALL ON FUNCTION upsert_push_device(uuid, text, "PushPlatform", "PushProviderKind") FROM PUBLIC;
GRANT EXECUTE ON FUNCTION upsert_push_device(uuid, text, "PushPlatform", "PushProviderKind") TO app_user;

-- The push service said the token is dead (Expo: DeviceNotRegistered): the worker drops it, whoever it belonged to.
CREATE FUNCTION remove_push_token(p_token text) RETURNS integer
LANGUAGE sql VOLATILE SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
  WITH gone AS (DELETE FROM push_devices WHERE token = p_token RETURNING 1) SELECT count(*)::integer FROM gone
$$;
REVOKE ALL ON FUNCTION remove_push_token(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION remove_push_token(text) TO app_user;

-- ---------------------------------------------------------------------------------------------------------------------
-- The worker's two cross-business reads, as narrow SECURITY DEFINER functions (the same pattern as stale_pending_imports):
-- each runs as the owner, which has one SELECT policy of its own naming it and nobody else, and returns only what the caller
-- needs. app_user stays fully confined; no session setting switches any policy on.
-- ---------------------------------------------------------------------------------------------------------------------

-- 1. The scheduler tick: which rules are switched on, with their business's time zone, to work out what is due.
CREATE POLICY tick_owner_select ON automation_rules FOR SELECT TO CURRENT_USER USING (enabled);
CREATE POLICY tick_owner_select ON tenants FOR SELECT TO CURRENT_USER USING (true);

CREATE FUNCTION enabled_automation_rules(after_id uuid, max_rows integer DEFAULT 500)
RETURNS TABLE (id uuid, tenant_id uuid, kind "AutomationKind", config jsonb, timezone text)
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
  SELECT r.id, r.tenant_id, r.kind, r.config, t.timezone
  FROM automation_rules r
  JOIN tenants t ON t.id = r.tenant_id
  WHERE r.enabled AND (after_id IS NULL OR r.id > after_id)
  ORDER BY r.id
  LIMIT LEAST(GREATEST(max_rows, 1), 2000)
$$;
REVOKE ALL ON FUNCTION enabled_automation_rules(uuid, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION enabled_automation_rules(uuid, integer) TO app_user;

-- 2. Deliveries that were saved but never queued (the API or worker died between the commit and the queue): pending for a while.
CREATE POLICY sweep_owner_select ON notification_deliveries FOR SELECT TO CURRENT_USER USING (status = 'pending');

CREATE FUNCTION stale_pending_deliveries(older_than_seconds integer, max_rows integer DEFAULT 200)
RETURNS TABLE (id uuid, tenant_id uuid)
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
  SELECT d.id, d.tenant_id
  FROM notification_deliveries d
  WHERE d.status = 'pending' AND d.channel <> 'in_app' AND d.attempts = 0
    AND d.created_at < now() - make_interval(secs => GREATEST(older_than_seconds, 30))
  ORDER BY d.created_at
  LIMIT LEAST(GREATEST(max_rows, 1), 1000)
$$;
REVOKE ALL ON FUNCTION stale_pending_deliveries(integer, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION stale_pending_deliveries(integer, integer) TO app_user;
