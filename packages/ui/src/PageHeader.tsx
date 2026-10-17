import type { ReactNode } from 'react';
import { Stack } from './Stack';
import { Text } from './Text';

/** The title of a screen, with an optional explanation and the screen's main actions on the right. */
export function PageHeader({
  title,
  description,
  actions,
}: {
  title: string;
  description?: string;
  actions?: ReactNode;
}) {
  return (
    <Stack direction="row" justify="between" align="start" gap={3} wrap>
      <Stack gap={1} grow>
        <Text variant="display" aria-level={1}>
          {title}
        </Text>
        {description && <Text tone="muted">{description}</Text>}
      </Stack>
      {actions && (
        <Stack direction="row" gap={2} wrap>
          {actions}
        </Stack>
      )}
    </Stack>
  );
}
