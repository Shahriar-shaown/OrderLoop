import type { TenantDeletionStatus } from '@orderloop/contracts';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useAuth } from '../core/auth';
import { useRuntime } from '../core/runtime';

export const tenantDeletionKey = (tenantId: string | undefined) =>
  ['tenant-deletion', tenantId] as const;

/**
 * Whether the signed-in business is scheduled for deletion (any member may ask). The app shell reads this to show the blocking
 * screen. A failed answer is not treated as "scheduled": the screens simply carry on and the API refuses what must be refused.
 */
export function useTenantDeletion(enabled = true) {
  const { api } = useRuntime();
  const { session } = useAuth();
  return useQuery({
    queryKey: tenantDeletionKey(session?.tenant.id),
    queryFn: () => api.tenantDeletion.status(),
    enabled: Boolean(session) && enabled,
    retry: false,
    staleTime: 30_000,
  });
}

/** Put a status the API just returned (a request or a cancellation) where every screen reads it. */
export function useSetTenantDeletion() {
  const queryClient = useQueryClient();
  const { session } = useAuth();
  return (status: TenantDeletionStatus) =>
    queryClient.setQueryData(tenantDeletionKey(session?.tenant.id), status);
}
