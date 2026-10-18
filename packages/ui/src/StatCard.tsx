import type { ReactNode } from 'react';
import { Card } from './Card';
import { Stack } from './Stack';
import { Text } from './Text';

/**
 * One headline figure: a label, the value, and a line of context. Use for dashboard numbers. `footer` is for a link to the
 * list the number came from, so every figure leads somewhere.
 */
export function StatCard({
  label,
  value,
  hint,
  footer,
  tone = 'default',
}: {
  label: string;
  value: string;
  hint?: string | undefined;
  footer?: ReactNode;
  tone?: 'default' | 'danger';
}) {
  return (
    <Card variant="outlined" padding="md" role="group" aria-label={`${label}: ${value}`}>
      <Stack gap={1}>
        <Text variant="caption" tone="muted" weight="medium">
          {label}
        </Text>
        {/* A figure, not a heading: the big type must not add a level-1 heading for every card. */}
        <Text variant="display" role="none" tone={tone === 'danger' ? 'danger' : 'default'}>
          {value}
        </Text>
        {hint ? (
          <Text variant="caption" tone="muted">
            {hint}
          </Text>
        ) : null}
        {footer}
      </Stack>
    </Card>
  );
}
