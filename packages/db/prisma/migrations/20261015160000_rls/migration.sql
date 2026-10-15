-- Row-level security for tenant-owned tables (architecture.md section 5).
--
-- The application connects as app_user (NOSUPERUSER, NOBYPASSRLS, not the table owner) and sets
--   SELECT set_config('app.tenant_id', '<uuid>', true)   -- transaction-local
--   SELECT set_config('app.user_id',   '<uuid>', true)
-- at the start of every transaction. With neither set, every tenant table returns zero rows and
-- rejects writes: a forgotten filter fails closed instead of leaking.

CREATE FUNCTION app_current_tenant() RETURNS uuid
  LANGUAGE sql STABLE
  AS $$ SELECT NULLIF(current_setting('app.tenant_id', true), '')::uuid $$;

CREATE FUNCTION app_current_user() RETURNS uuid
  LANGUAGE sql STABLE
  AS $$ SELECT NULLIF(current_setting('app.user_id', true), '')::uuid $$;

-- tenants: a tenant row is visible only inside its own context.
ALTER TABLE tenants ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenants FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON tenants
  USING (id = app_current_tenant())
  WITH CHECK (id = app_current_tenant());

-- memberships: tenant-scoped. A user may additionally READ their own memberships across tenants
-- (needed at login to list the tenants they can enter); writes stay tenant-scoped.
ALTER TABLE memberships ENABLE ROW LEVEL SECURITY;
ALTER TABLE memberships FORCE ROW LEVEL SECURITY;
CREATE POLICY memberships_select ON memberships FOR SELECT
  USING (tenant_id = app_current_tenant() OR user_id = app_current_user());
CREATE POLICY memberships_insert ON memberships FOR INSERT
  WITH CHECK (tenant_id = app_current_tenant());
CREATE POLICY memberships_update ON memberships FOR UPDATE
  USING (tenant_id = app_current_tenant())
  WITH CHECK (tenant_id = app_current_tenant());
CREATE POLICY memberships_delete ON memberships FOR DELETE
  USING (tenant_id = app_current_tenant());

-- invitations: tenant-scoped.
ALTER TABLE invitations ENABLE ROW LEVEL SECURITY;
ALTER TABLE invitations FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON invitations
  USING (tenant_id = app_current_tenant())
  WITH CHECK (tenant_id = app_current_tenant());

-- audit_logs: append-only. Rows with a null tenant (no tenant context) can be written but are never
-- readable by the application.
ALTER TABLE audit_logs ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_logs FORCE ROW LEVEL SECURITY;
CREATE POLICY audit_select ON audit_logs FOR SELECT
  USING (tenant_id = app_current_tenant());
CREATE POLICY audit_insert ON audit_logs FOR INSERT
  WITH CHECK (tenant_id = app_current_tenant() OR tenant_id IS NULL);
REVOKE UPDATE, DELETE, TRUNCATE ON audit_logs FROM app_user;

-- Least privilege: the runtime role has no business with Prisma's bookkeeping table.
REVOKE ALL ON TABLE _prisma_migrations FROM app_user;
