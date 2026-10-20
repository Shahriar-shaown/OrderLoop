import { Skeleton, Stack, useT } from '@orderloop/ui';
import type { ReactNode } from 'react';
import { View } from 'react-native';
import { QueryBoundary } from './QueryBoundary';

/**
 * Like QueryBoundary, but while loading it shows grey placeholder blocks the size of the content (so the page does not jump)
 * instead of a spinner. The block is announced as `label`. Errors show a message with a retry.
 */
export function SectionBoundary({
  isPending,
  isError,
  error,
  refetch,
  data,
  fetchStatus,
  label,
  lines = 3,
  height = 16,
  children,
}: {
  isPending: boolean;
  isError: boolean;
  error: unknown;
  refetch: () => void;
  data?: unknown;
  fetchStatus?: 'fetching' | 'paused' | 'idle';
  label: string;
  lines?: number;
  height?: number;
  children: ReactNode;
}) {
  const t = useT();
  // Offline with nothing loaded: the boundary's offline state, not placeholders that never fill.
  if (isPending && fetchStatus !== 'paused')
    return (
      <View role="status" aria-label={t(label)}>
        <Stack gap={3}>
          {Array.from({ length: lines }, (_, i) => (
            <Skeleton
              key={i}
              height={height}
              width={i === lines - 1 && lines > 1 ? '60%' : '100%'}
            />
          ))}
        </Stack>
      </View>
    );
  return (
    <QueryBoundary
      isPending={isPending}
      isError={isError}
      error={error}
      refetch={refetch}
      data={data}
      fetchStatus={fetchStatus}
    >
      {children}
    </QueryBoundary>
  );
}
