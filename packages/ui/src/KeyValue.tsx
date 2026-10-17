import type { ReactNode } from 'react';
import { Stack } from './Stack';
import { Text } from './Text';

/** Label/value pairs for a detail screen. */
export function KeyValueList({ items }: { items: { label: string; value: ReactNode }[] }) {
  return (
    <Stack gap={3}>
      {items.map((item) => (
        <Stack key={item.label} gap={1}>
          <Text variant="caption" tone="muted" weight="medium">
            {item.label}
          </Text>
          {typeof item.value === 'string' || typeof item.value === 'number' ? (
            <Text>{item.value}</Text>
          ) : (
            item.value
          )}
        </Stack>
      ))}
    </Stack>
  );
}
