import { Skeleton, Stack } from '@orderloop/ui';
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
  label,
  lines = 3,
  height = 16,
  children,
}: {
  isPending: boolean;
  isError: boolean;
  error: unknown;
  refetch: () => void;
  label: string;
  lines?: number;
  height?: number;
  children: ReactNode;
}) {
  if (isPending)
    return (
      <View role="status" aria-label={label}>
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
    <QueryBoundary isPending={false} isError={isError} error={error} refetch={refetch}>
      {children}
    </QueryBoundary>
  );
}
