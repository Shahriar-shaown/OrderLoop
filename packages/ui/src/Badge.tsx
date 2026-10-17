import type { ReactNode } from 'react';
import { View } from 'react-native';
import { Text } from './Text';
import { useTheme } from './theme';
import { radius, space } from './tokens';

export type Tone = 'info' | 'success' | 'warning' | 'error' | 'neutral';

/** A small status pill. The tone colours it; the text must always say the status too (colour alone is not enough). */
export function Badge({ children, tone = 'neutral' }: { children: ReactNode; tone?: Tone }) {
  const { colors } = useTheme();
  const c = colors.tones[tone];
  return (
    <View
      style={{
        alignSelf: 'flex-start',
        backgroundColor: c.background,
        borderColor: c.border,
        borderWidth: 1,
        borderRadius: radius.full,
        paddingHorizontal: space[2],
        paddingVertical: 2,
      }}
    >
      <Text variant="caption" weight="medium" style={{ color: c.text }}>
        {children}
      </Text>
    </View>
  );
}
