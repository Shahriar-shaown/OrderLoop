import type { ReactNode } from 'react';
import { Card } from './Card';
import { Stack } from './Stack';
import { Text } from './Text';

/** What a list shows when there is nothing to list: say why, and offer the next step. */
export function EmptyState({
  title,
  children,
  action,
}: {
  title: string;
  children?: ReactNode;
  action?: ReactNode;
}) {
  return (
    <Card variant="filled" padding="lg">
      <Stack gap={2} align="center">
        <Text variant="heading" align="center">
          {title}
        </Text>
        {typeof children === 'string' ? (
          <Text tone="muted" align="center">
            {children}
          </Text>
        ) : (
          children
        )}
        {action}
      </Stack>
    </Card>
  );
}
