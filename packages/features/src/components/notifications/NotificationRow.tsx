import type { Notification } from '@orderloop/contracts';
import { Badge, Icon, Stack, Text, useBreakpoint, useT, useTheme } from '@orderloop/ui';
import { Pressable, View } from 'react-native';
import { KIND_INFO } from '../../lib/automation';
import { formatWhen } from '../../lib/format';
import { notificationBody } from '../../lib/notificationText';

/**
 * One notification in the list. A notification that has not been read is tinted and says "New" in words (colour alone is not
 * enough). The title and text come from the server in English and are translated here where a translation exists.
 */
export function NotificationRow({
  notification,
  onOpen,
}: {
  notification: Notification;
  onOpen: (notification: Notification) => void;
}) {
  const { colors } = useTheme();
  const { isTouch } = useBreakpoint();
  const t = useT();
  const unread = notification.readAt === null;
  return (
    <Pressable
      role="button"
      onPress={() => onOpen(notification)}
      style={(state) => [
        {
          flexDirection: 'row',
          gap: 12,
          alignItems: 'flex-start',
          padding: 16,
          minHeight: isTouch ? 64 : 56,
          borderRadius: 12,
          borderWidth: 1,
          borderColor: unread ? colors.primaryTint : colors.border,
          backgroundColor: unread ? colors.primarySoft : colors.surface,
        },
        (state as { focused?: boolean }).focused
          ? ({ outlineWidth: 3, outlineStyle: 'solid', outlineColor: colors.focus } as object)
          : null,
      ]}
    >
      <View
        style={{
          width: 36,
          height: 36,
          borderRadius: 18,
          alignItems: 'center',
          justifyContent: 'center',
          backgroundColor: unread ? colors.primaryTint : colors.subtle,
        }}
      >
        <Icon
          name={KIND_INFO[notification.kind].icon}
          size={18}
          color={unread ? colors.primary : colors.muted}
        />
      </View>
      <Stack gap={1} grow>
        <Stack direction="row" gap={2} align="center" wrap>
          <Text variant="label" weight={unread ? 'semibold' : 'medium'}>
            {notification.title}
          </Text>
          {unread && <Badge tone="brand">New</Badge>}
        </Stack>
        <Text tone="muted" verbatim>
          {notificationBody(notification, t)}
        </Text>
        <Text variant="caption" tone="muted">
          {formatWhen(notification.createdAt)}
        </Text>
      </Stack>
    </Pressable>
  );
}
