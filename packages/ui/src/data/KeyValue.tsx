import type { ReactNode } from 'react';
import { View } from 'react-native';
import { Stack } from '../layout/Stack';
import { Text } from '../Text';
import { useTheme } from '../theme/theme';
import { space } from '../theme/tokens';
import { useBreakpoint } from '../layout/useBreakpoint';

/**
 * Label/value pairs for a detail screen. `inline` puts the label on the left and the value on the right (a summary panel);
 * the default stacks them. `emphasis` rows (a total) are bold with a rule above.
 */
export function KeyValueList({
  items,
  layout = 'stacked',
}: {
  items: {
    label: string;
    value: ReactNode;
    emphasis?: boolean;
    tone?: 'default' | 'success' | 'danger' | 'muted';
  }[];
  layout?: 'stacked' | 'inline';
}) {
  const { colors } = useTheme();
  const { isMobile } = useBreakpoint();
  const inline = layout === 'inline' && !(isMobile && false);
  return (
    <Stack gap={inline ? 2 : 3}>
      {items.map((item) => {
        const value =
          typeof item.value === 'string' || typeof item.value === 'number' ? (
            <Text
              numeric
              variant={item.emphasis ? 'heading' : 'body'}
              tone={
                item.tone === 'muted'
                  ? 'muted'
                  : item.tone === 'success'
                    ? 'success'
                    : item.tone === 'danger'
                      ? 'danger'
                      : 'default'
              }
              align={inline ? 'right' : 'left'}
              // minWidth 0 lets a long unbroken value (a URL, a tracking code) wrap instead of pushing past the edge.
              style={{ flexShrink: 1, minWidth: 0 }}
            >
              {item.value}
            </Text>
          ) : inline ? (
            // A component as the value (a link, a badge, a sentence) must also be able to shrink and wrap.
            <View style={{ flexShrink: 1, minWidth: 0, alignItems: 'flex-end' }}>{item.value}</View>
          ) : (
            item.value
          );
        return inline ? (
          <View
            key={item.label}
            style={[
              {
                flexDirection: 'row',
                justifyContent: 'space-between',
                alignItems: 'flex-start',
                gap: space[4],
                paddingVertical: 2,
              },
              item.emphasis
                ? {
                    borderTopWidth: 1,
                    borderTopColor: colors.border,
                    paddingTop: space[3],
                    marginTop: space[1],
                  }
                : null,
            ]}
          >
            <Text
              tone={item.emphasis ? 'default' : 'muted'}
              variant={item.emphasis ? 'heading' : 'body'}
              style={{ flexShrink: 0, maxWidth: '55%' }}
            >
              {item.label}
            </Text>
            {value}
          </View>
        ) : (
          <Stack key={item.label} gap={1}>
            <Text variant="caption" tone="muted" weight="medium">
              {item.label}
            </Text>
            {value}
          </Stack>
        );
      })}
    </Stack>
  );
}
