import type { ReactNode } from 'react';
import { View } from 'react-native';
import { Card } from './Card';
import { Icon } from './Icon';
import type { IconName } from './icons';
import { Stack } from './Stack';
import { Text } from './Text';
import { useTheme } from './theme';
import { radius } from './tokens';

/**
 * One headline figure (a KPI card): a label with an icon chip, the value in tabular type, and a line of context. `tone`
 * "danger" is for a figure that is a problem (an unpaid balance). `footer` is for a link to the list the number came from,
 * so every figure leads somewhere.
 */
export function StatCard({
  label,
  value,
  hint,
  footer,
  icon,
  tone = 'default',
}: {
  label: string;
  value: string;
  hint?: ReactNode;
  footer?: ReactNode;
  icon?: IconName;
  tone?: 'default' | 'danger' | 'warning';
}) {
  const { colors } = useTheme();
  const accent =
    tone === 'danger'
      ? colors.tones.error
      : tone === 'warning'
        ? colors.tones.warning
        : colors.tones.brand;
  return (
    <Card
      variant="outlined"
      padding="md"
      role="group"
      aria-label={`${label}: ${value}`}
      style={{ flexGrow: 1, minWidth: 0 }}
    >
      <Stack gap={2}>
        <Stack direction="row" justify="between" align="start" gap={2}>
          <Text variant="small" tone="muted" style={{ flexShrink: 1 }}>
            {label}
          </Text>
          {icon && (
            <View
              style={{
                width: 32,
                height: 32,
                borderRadius: radius.md,
                backgroundColor: accent.background,
                alignItems: 'center',
                justifyContent: 'center',
              }}
            >
              <Icon name={icon} size={16} color={accent.text} />
            </View>
          )}
        </Stack>
        {/* A figure, not a heading: the big type must not add a level-1 heading for every card. */}
        <Text
          variant="metric"
          role="none"
          numeric
          numberOfLines={1}
          style={
            value.length > 13
              ? { fontSize: 18, lineHeight: 28 }
              : value.length > 9
                ? { fontSize: 22, lineHeight: 30 }
                : undefined
          }
          tone={tone === 'danger' ? 'danger' : 'default'}
        >
          {value}
        </Text>
        {typeof hint === 'string' ? (
          <Text variant="caption" tone="muted">
            {hint}
          </Text>
        ) : (
          hint
        )}
        {footer}
      </Stack>
    </Card>
  );
}
