import type { ReactNode } from 'react';
import { View } from 'react-native';
import { Text } from '../Text';
import { useTheme } from '../theme/theme';
import { radius, space, type Tone } from '../theme/tokens';

export type { Tone } from '../theme/tokens';

/**
 * A small status pill. The tone colours it; the text must always say the status too (colour alone is not enough).
 * `dot` adds the status dot used for order, payment and shipment statuses.
 */
export function Badge({
  children,
  tone = 'neutral',
  dot = false,
}: {
  children: ReactNode;
  tone?: Tone;
  dot?: boolean;
}) {
  const { colors } = useTheme();
  const c = colors.tones[tone];
  return (
    <View
      style={{
        alignSelf: 'flex-start',
        flexDirection: 'row',
        alignItems: 'center',
        gap: 6,
        backgroundColor: c.background,
        borderRadius: radius.full,
        paddingHorizontal: space[2],
        paddingVertical: 2,
        minHeight: 22,
      }}
    >
      {dot && <View style={{ width: 6, height: 6, borderRadius: 3, backgroundColor: c.dot }} />}
      <Text variant="fine" style={{ color: c.text }}>
        {children}
      </Text>
    </View>
  );
}
