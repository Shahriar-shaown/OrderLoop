-- Replaces the sweep_pending_select policy of 20261023100000_import_sweep. That policy let anyone who could call
-- set_config('app.sweep', ...) read every tenant's PENDING imports, SQL injection included. The worker's one cross-tenant
-- read is now a function that can only ever return (id, tenant_id) of PENDING imports older than N seconds.
DROP POLICY sweep_pending_select ON import_jobs;

-- The function runs as its owner (the migrator), which is not subject to the tenant policy without FORCE; app_user is not
-- the owner, so it stays fully confined. (The next migration restores FORCE with an owner-only policy instead.)
ALTER TABLE import_jobs NO FORCE ROW LEVEL SECURITY;

CREATE FUNCTION stale_pending_imports(older_than_seconds integer, max_rows integer DEFAULT 100)
RETURNS TABLE (id uuid, tenant_id uuid)
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
  SELECT j.id, j.tenant_id
  FROM import_jobs j
  WHERE j.status = 'PENDING' AND j.created_at < now() - make_interval(secs => older_than_seconds)
  ORDER BY j.created_at
  LIMIT max_rows
$$;

REVOKE ALL ON FUNCTION stale_pending_imports(integer, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION stale_pending_imports(integer, integer) TO app_user;
