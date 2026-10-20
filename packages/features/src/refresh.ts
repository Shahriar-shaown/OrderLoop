import { useQueryClient } from '@tanstack/react-query';
import { useCallback } from 'react';

/** Refetch everything on screen (pull to refresh). Resolves when the data has arrived or failed. */
export function useRefreshAll(): () => Promise<void> {
  const client = useQueryClient();
  return useCallback(
    () =>
      client.refetchQueries({ type: 'active' }).then(
        () => undefined,
        () => undefined,
      ),
    [client],
  );
}
