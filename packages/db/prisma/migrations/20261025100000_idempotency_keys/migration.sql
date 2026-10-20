-- A retried or double-submitted create returns the response stored here instead of creating a second row. One generic
-- table for every create endpoint: a row belongs to a tenant (tenant_id) or, for creating a business, which happens before
-- its tenant exists, to a user (user_id with a null tenant_id). The key is written in the same transaction as the create.

-- CreateTable
CREATE TABLE "idempotency_keys" (
    "id" UUID NOT NULL,
    "tenant_id" UUID,
    "user_id" UUID,
    "scope" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "request_hash" TEXT NOT NULL,
    "response_body" JSONB NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "idempotency_keys_pkey" PRIMARY KEY ("id"),
    -- exactly one owner: a tenant, or (tenant_id null) a user
    CONSTRAINT "idempotency_keys_one_owner" CHECK (("tenant_id" IS NULL) <> ("user_id" IS NULL))
);

-- CreateIndex (null owners are distinct in a unique index, so each one constrains only the rows of its own kind)
CREATE UNIQUE INDEX "idempotency_keys_tenant_id_scope_key_key" ON "idempotency_keys"("tenant_id", "scope", "key");
CREATE UNIQUE INDEX "idempotency_keys_user_id_scope_key_key" ON "idempotency_keys"("user_id", "scope", "key");
CREATE INDEX "idempotency_keys_created_at_idx" ON "idempotency_keys"("created_at");

-- AddForeignKey
ALTER TABLE "idempotency_keys" ADD CONSTRAINT "idempotency_keys_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "idempotency_keys" ADD CONSTRAINT "idempotency_keys_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Row-level security: a tenant's rows inside its context; a user's own tenant-less rows inside theirs.
ALTER TABLE idempotency_keys ENABLE ROW LEVEL SECURITY;
ALTER TABLE idempotency_keys FORCE  ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON idempotency_keys
  USING (tenant_id = app_current_tenant() OR (tenant_id IS NULL AND user_id = app_current_user()))
  WITH CHECK (tenant_id = app_current_tenant() OR (tenant_id IS NULL AND user_id = app_current_user()));

-- Expiry. The worker deletes keys older than a day across all tenants, which row-level security forbids the runtime role.
-- Like stale_pending_imports, that is one narrow SECURITY DEFINER function (it runs as the owner, which has a policy of its
-- own naming it and nobody else), and it can only delete rows older than an hour, whatever it is asked.
-- (A DELETE with a WHERE clause must also be allowed to see the rows, hence the select policy.)
CREATE POLICY purge_owner_select ON idempotency_keys FOR SELECT TO CURRENT_USER
  USING (created_at < now() - interval '1 hour');
CREATE POLICY purge_owner_delete ON idempotency_keys FOR DELETE TO CURRENT_USER
  USING (created_at < now() - interval '1 hour');

CREATE FUNCTION purge_idempotency_keys(older_than_seconds integer) RETURNS integer
LANGUAGE sql SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
  WITH gone AS (
    DELETE FROM idempotency_keys
    WHERE created_at < now() - make_interval(secs => GREATEST(older_than_seconds, 3600))
    RETURNING 1
  )
  SELECT count(*)::integer FROM gone
$$;

REVOKE ALL ON FUNCTION purge_idempotency_keys(integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION purge_idempotency_keys(integer) TO app_user;
