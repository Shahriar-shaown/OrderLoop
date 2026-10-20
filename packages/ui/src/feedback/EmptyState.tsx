import type { ReactNode } from 'react';
import { View } from 'react-native';
import { Card } from '../layout/Card';
import { Icon } from './Icon';
import type { IconName } from './icons';
import { Stack } from '../layout/Stack';
import { Text } from '../Text';
import { useTheme } from '../theme/theme';

/** What a list shows when there is nothing to list: say why, and offer the next step. */
export function EmptyState({
  title,
  children,
  action,
  icon,
}: {
  title: string;
  children?: ReactNode;
  action?: ReactNode;
  icon?: IconName;
}) {
  const { colors } = useTheme();
  return (
    <Card
      variant="plain"
      padding="lg"
      style={{
        backgroundColor: colors.surface,
        borderWidth: 1,
        borderStyle: 'dashed',
        borderColor: colors.borderStrong,
      }}
    >
      <Stack gap={3} align="center">
        {icon && (
          <View
            style={{
              width: 48,
              height: 48,
              borderRadius: 24,
              backgroundColor: colors.primarySoft,
              alignItems: 'center',
              justifyContent: 'center',
            }}
          >
            <Icon name={icon} size={22} color={colors.primary} />
          </View>
        )}
        <Text variant="heading" align="center">
          {title}
        </Text>
        {typeof children === 'string' ? (
          <Text tone="muted" align="center" style={{ maxWidth: 420 }}>
            {children}
          </Text>
        ) : (
          children
        )}
        {action}
      </Stack>
    </Card>
  );
}
