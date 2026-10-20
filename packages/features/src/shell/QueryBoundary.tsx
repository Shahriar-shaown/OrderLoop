import { Alert, Button, LoadingState } from '@orderloop/ui';
import type { ReactNode } from 'react';
import { messageFor } from '../forms/errors';

/** The states every data screen has: loading, failed (with a retry), and loaded. Pass a query result (or its parts). */
export function QueryBoundary({
  isPending,
  isError,
  error,
  refetch,
  children,
  label = 'Loading',
}: {
  isPending: boolean;
  isError: boolean;
  error: unknown;
  refetch: () => void;
  children: ReactNode;
  label?: string;
}) {
  if (isPending) return <LoadingState label={label} />;
  if (isError) {
    return (
      <Alert
        tone="error"
        action={
          <Button variant="secondary" onPress={refetch}>
            Try again
          </Button>
        }
      >
        {messageFor(error)}
      </Alert>
    );
  }
  return <>{children}</>;
}
