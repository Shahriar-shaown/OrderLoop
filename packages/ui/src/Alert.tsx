import type { ReactNode } from 'react';
import { View } from 'react-native';
import { Icon } from './Icon';
import type { IconName } from './icons';
import { Stack } from './Stack';
import { Text } from './Text';
import { useTheme } from './theme';
import { radius, space, type Tone } from './tokens';

const ICON: Record<Tone, IconName> = {
  info: 'info',
  success: 'check-circle',
  warning: 'alert',
  error: 'alert',
  neutral: 'info',
  brand: 'info',
};

/**
 * An inline message or banner. Errors are announced immediately (`role="alert"`); the other tones politely (`role="status"`).
 * `title` is the bold first line; `action` sits at the right (a button), or below on a narrow screen.
 */
export function Alert({
  tone = 'info',
  title,
  children,
  action,
  icon,
}: {
  tone?: Tone;
  title?: string;
  children: ReactNode;
  action?: ReactNode;
  /** Replace the tone's default icon. */
  icon?: IconName;
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
        paddingHorizontal: space[4],
        paddingVertical: space[3],
      }}
    >
      <Stack direction="row" gap={3} align="center" justify="between" wrap>
        <Stack direction="row" gap={3} align="start" grow style={{ minWidth: 220 }}>
          <View style={{ paddingTop: 2 }}>
            <Icon name={icon ?? ICON[tone]} size={18} color={c.text} />
          </View>
          <Stack gap={1} grow>
            {title && (
              <Text variant="label" style={{ color: c.text }}>
                {title}
              </Text>
            )}
            {typeof children === 'string' ? (
              <Text variant={title ? 'small' : 'body'} style={{ color: c.text }}>
                {children}
              </Text>
            ) : (
              children
            )}
          </Stack>
        </Stack>
        {action}
      </Stack>
    </View>
  );
}
