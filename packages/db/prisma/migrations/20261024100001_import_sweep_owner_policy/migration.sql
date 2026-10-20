-- Every tenant table keeps FORCE ROW LEVEL SECURITY (the isolation suite requires it), so the owner that runs
-- stale_pending_imports() needs a policy of its own. It names the owner role (the migrator running this migration), so it
-- matches nobody else: app_user is not the owner, is not a member of it, and stays fully confined. Unlike the policy dropped
-- in the previous migration, no session setting can switch it on.
ALTER TABLE import_jobs FORCE ROW LEVEL SECURITY;
CREATE POLICY sweep_owner_select ON import_jobs FOR SELECT TO CURRENT_USER USING (status = 'PENDING');
