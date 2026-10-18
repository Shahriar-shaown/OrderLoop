import type { ReactNode } from 'react';
import { View, type ViewProps } from 'react-native';
import { Stack } from './Stack';
import { Text } from './Text';
import { radius, space } from './tokens';
import { createVariants } from './variants';

const useCardStyle = createVariants((t) => ({
  base: { borderRadius: radius.lg, minWidth: 0 },
  variants: {
    variant: {
      outlined: {
        borderWidth: 1,
        borderColor: t.colors.border,
        backgroundColor: t.colors.surface,
      },
      filled: { backgroundColor: t.colors.subtle, borderWidth: 1, borderColor: t.colors.border },
      plain: {},
    },
    padding: {
      none: { padding: 0 },
      sm: { padding: space[3] },
      md: { padding: space[5] },
      lg: { padding: space[6] },
    },
  },
  defaults: { variant: 'outlined', padding: 'md' },
}));

export interface CardProps extends ViewProps {
  variant?: 'outlined' | 'filled' | 'plain';
  padding?: 'none' | 'sm' | 'md' | 'lg';
}

export function Card({ variant, padding, style, ...rest }: CardProps) {
  const base = useCardStyle({ variant, padding });
  return <View style={[base, style]} {...rest} />;
}

/** A titled group of content in a card: the building block of forms and detail pages. */
export function Section({
  title,
  description,
  actions,
  children,
  ...card
}: CardProps & { title: string; description?: string; actions?: ReactNode }) {
  return (
    <Card {...card}>
      <Stack gap={4}>
        <Stack direction="row" justify="between" align="start" gap={3} wrap>
          <Stack gap={1} grow>
            <Text variant="title" role="heading" aria-level={2}>
              {title}
            </Text>
            {description && (
              <Text tone="muted" variant="body">
                {description}
              </Text>
            )}
          </Stack>
          {actions}
        </Stack>
        {children}
      </Stack>
    </Card>
  );
}
