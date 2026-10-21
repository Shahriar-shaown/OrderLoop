-- Redis loss recovery for imports. An import that was RUNNING when Redis was wiped has no queue job any more, and the sweeper
-- only looked at PENDING rows. This adds the same kind of narrow cross-business read for RUNNING rows that have not been
-- (re)started for a long time: ids only, never the CSV. Additive: the PENDING policy and function are untouched.
CREATE POLICY sweep_owner_select_running ON import_jobs FOR SELECT TO CURRENT_USER USING (status = 'RUNNING');

CREATE FUNCTION stalled_running_imports(older_than_seconds integer, max_rows integer DEFAULT 100)
RETURNS TABLE (id uuid, tenant_id uuid)
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
  SELECT j.id, j.tenant_id
  FROM import_jobs j
  WHERE j.status = 'RUNNING'
    AND COALESCE(j.started_at, j.created_at) < now() - make_interval(secs => older_than_seconds)
  ORDER BY COALESCE(j.started_at, j.created_at)
  LIMIT LEAST(GREATEST(max_rows, 1), 1000)
$$;

REVOKE ALL ON FUNCTION stalled_running_imports(integer, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION stalled_running_imports(integer, integer) TO app_user;
