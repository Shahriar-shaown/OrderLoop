import { Alert, Button, EmptyState, LoadingState } from '@orderloop/ui';
import type { ReactNode } from 'react';
import { messageFor } from '../forms/errors';

/**
 * The states every data screen has: loading, offline, failed (with a retry), and loaded. Pass a query result (or its parts;
 * `data` and `fetchStatus` come with a spread result). Data already on screen is never replaced by an error: a refresh that
 * fails keeps it and adds a small notice, because the person can still use what they have.
 */
export function QueryBoundary({
  isPending,
  isError,
  error,
  refetch,
  data,
  fetchStatus,
  children,
  label = 'Loading',
}: {
  isPending: boolean;
  isError: boolean;
  error: unknown;
  refetch: () => void;
  /** What the query holds so far (cached or fresh). Left out, the screen is taken to have none. */
  data?: unknown;
  /** `paused` is a query that wants to fetch but has no connection. */
  fetchStatus?: 'fetching' | 'paused' | 'idle';
  children: ReactNode;
  label?: string;
}) {
  const retry = (
    <Button variant="secondary" onPress={refetch}>
      Try again
    </Button>
  );
  if (isPending && fetchStatus === 'paused') {
    return (
      <EmptyState title="You are offline" icon="plug" action={retry}>
        This page loads by itself when you are back online. Or connect now and press Try again.
      </EmptyState>
    );
  }
  if (isPending) return <LoadingState label={label} />;
  if (isError && data === undefined) {
    return (
      <Alert tone="error" action={retry}>
        {messageFor(error)}
      </Alert>
    );
  }
  return (
    <>
      {isError ? (
        <Alert tone="warning" action={retry}>
          Could not refresh. Showing what was loaded before.
        </Alert>
      ) : null}
      {children}
    </>
  );
}
