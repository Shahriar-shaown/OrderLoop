import type { ReactNode } from 'react';
import { Stack } from './Stack';
import { Text } from './Text';

/**
 * A titled block around a DataTable (or its empty state): the heading and an optional description and actions sit above the
 * table's own frame, so the table is not drawn inside a second card.
 */
export function TableSection({
  title,
  description,
  actions,
  children,
}: {
  title: string;
  description?: string;
  actions?: ReactNode;
  children: ReactNode;
}) {
  return (
    <Stack gap={3}>
      <Stack direction="row" justify="between" align="end" gap={3} wrap>
        <Stack gap={1} grow style={{ minWidth: 220 }}>
          <Text variant="title">{title}</Text>
          {description ? <Text tone="muted">{description}</Text> : null}
        </Stack>
        {actions}
      </Stack>
      {children}
    </Stack>
  );
}
