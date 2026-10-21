import { Button, Text, useTheme } from '@orderloop/ui';
import { View } from 'react-native';
import { useUnreadCount } from '../../lib/notifications';

/** The bell in the app's header: a count of what has not been read, opening the notifications. */
export function NotificationBell() {
  const { data } = useUnreadCount();
  const { colors } = useTheme();
  const count = data ?? 0;
  return (
    <View>
      <Button
        variant="ghost"
        icon="bell"
        href="/notifications"
        accessibilityLabel={count > 0 ? `Notifications, ${count} unread` : 'Notifications'}
      />
      {count > 0 && (
        <View
          pointerEvents="none"
          aria-hidden
          style={{
            position: 'absolute',
            top: 2,
            right: 0,
            minWidth: 18,
            height: 18,
            borderRadius: 9,
            paddingHorizontal: 4,
            alignItems: 'center',
            justifyContent: 'center',
            backgroundColor: colors.danger,
          }}
        >
          <Text variant="caption" numeric style={{ color: colors.onDanger, lineHeight: 14 }}>
            {count > 99 ? '99+' : String(count)}
          </Text>
        </View>
      )}
    </View>
  );
}
