/**
 * Every table is classified. The tenant-isolation suite fails when a table appears in the database
 * that is in neither list, or when a TENANT table lacks forced row-level security.
 */
export const TENANT_TABLES = ['tenants', 'memberships', 'invitations', 'audit_logs'] as const;

/**
 * Global auth tables: reached before any tenant is known (login, refresh), keyed by unguessable
 * secrets or unique identity. They hold no tenant business data.
 */
export const GLOBAL_TABLES = ['users', 'sessions', 'refresh_tokens'] as const;

/** Prisma bookkeeping; not reachable by the runtime role. */
export const SYSTEM_TABLES = ['_prisma_migrations'] as const;
