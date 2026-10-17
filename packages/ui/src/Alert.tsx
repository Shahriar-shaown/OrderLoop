import type { ReactNode } from 'react';
import { View } from 'react-native';
import type { Tone } from './Badge';
import { Stack } from './Stack';
import { Text } from './Text';
import { useTheme } from './theme';
import { radius, space } from './tokens';

/** An inline message. Errors are announced immediately (`role="alert"`); the other tones politely (`role="status"`). */
export function Alert({
  tone = 'info',
  title,
  children,
  action,
}: {
  tone?: Tone;
  title?: string;
  children: ReactNode;
  action?: ReactNode;
}) {
  const { colors } = useTheme();
  const c = colors.tones[tone];
  return (
    <View
      role={tone === 'error' ? 'alert' : 'status'}
      style={{
        backgroundColor: c.background,
        borderColor: c.border,
        borderWidth: 1,
        borderRadius: radius.md,
        padding: space[3],
      }}
    >
      <Stack direction="row" gap={3} align="center" justify="between" wrap>
        <Stack gap={1} grow>
          {title && (
            <Text weight="bold" style={{ color: c.text }}>
              {title}
            </Text>
          )}
          {typeof children === 'string' ? (
            <Text style={{ color: c.text }}>{children}</Text>
          ) : (
            children
          )}
        </Stack>
        {action}
      </Stack>
    </View>
  );
}
