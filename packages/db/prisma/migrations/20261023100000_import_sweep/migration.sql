-- The worker re-queues imports that were saved but never queued (the API died in between). To find them it must look
-- across tenants, which row-level security forbids. This adds one narrow way in: SELECT only, PENDING rows only, and
-- only inside a transaction that has said so with set_config('app.sweep', 'import_jobs', true). Without that setting
-- (every API request) the policy matches nothing, so isolation is unchanged; writes stay tenant-scoped.
CREATE POLICY sweep_pending_select ON import_jobs FOR SELECT
  USING (current_setting('app.sweep', true) = 'import_jobs' AND status = 'PENDING');
