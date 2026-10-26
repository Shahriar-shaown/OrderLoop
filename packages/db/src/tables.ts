/**
 * Every table is classified. The tenant-isolation suite fails when a table appears in the database
 * that is in neither list, or when a TENANT table lacks forced row-level security.
 */
export const TENANT_TABLES = [
  'tenants',
  'memberships',
  'invitations',
  'audit_logs',
  'categories',
  'suppliers',
  'customers',
  'customer_addresses',
  'order_counters',
  'orders',
  'order_items',
  'order_status_history',
  'products',
  'product_variants',
  'stock_locations',
  'stock_levels',
  'stock_movements',
  'reservations',
  'import_jobs',
  'courier_connections',
  'shipments',
  'shipment_events',
  'settlement_batches',
  'settlement_items',
  'settlement_item_events',
  'discrepancies',
  'manual_costs',
  'cod_receipts',
  'idempotency_keys',
  'automation_rules',
  'automation_runs',
  'automation_state',
  'notifications',
  'notification_preferences',
  'notification_deliveries',
  'messaging_consents',
  'social_connections',
  'social_oauth_sessions',
  'social_events',
  'social_drafts',
  'tiktok_connections',
  'tiktok_oauth_sessions',
  'tiktok_events',
  'tiktok_orders',
  'tiktok_sku_links',
  'tiktok_stock_holds',
] as const;

/** Tenant tables the runtime role may only INSERT into and SELECT from: history that must never be rewritten. */
export const APPEND_ONLY_TABLES = [
  'audit_logs',
  'stock_movements',
  'order_status_history',
  'shipment_events',
  'settlement_item_events',
] as const;

/**
 * Global auth tables: reached before any tenant is known (login, refresh), keyed by unguessable
 * secrets or unique identity. They hold no tenant business data.
 */
export const GLOBAL_TABLES = [
  'users',
  'sessions',
  'refresh_tokens',
  'user_tokens',
  // A person's phone: belongs to the user, applies to every business they are in. Row-level security confines each user to their own.
  'push_devices',
] as const;

/** Prisma bookkeeping; not reachable by the runtime role. */
export const SYSTEM_TABLES = ['_prisma_migrations'] as const;
