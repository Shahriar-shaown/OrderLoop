-- Re-assert the least-privilege rules from the RLS migration. Needed because an earlier version of
-- scripts/setup-roles.mjs re-granted DML on every existing table each time it ran, which silently
-- undid these REVOKEs on any database where setup was re-run after migrating. Idempotent.
REVOKE UPDATE, DELETE, TRUNCATE ON audit_logs FROM app_user;
REVOKE ALL ON TABLE _prisma_migrations FROM app_user;
