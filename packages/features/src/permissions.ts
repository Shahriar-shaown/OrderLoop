import type { Permission } from '@orderloop/contracts';
import { can } from '@orderloop/domain';
import { useAuth } from './auth';

/** Whether the signed-in user's role grants a permission. This only shapes the UI; the API enforces it for real. */
export function useCan(): (permission: Permission) => boolean {
  const { session } = useAuth();
  return (permission) => (session ? can(session.role, permission) : false);
}
