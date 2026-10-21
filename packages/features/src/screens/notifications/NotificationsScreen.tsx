import type { Notification } from '@orderloop/contracts';
import {
  Button,
  EmptyState,
  LoadMore,
  PageHeader,
  Stack,
  useNavigation,
  useToast,
} from '@orderloop/ui';
import { NotificationRow } from '../../components/notifications/NotificationRow';
import { PushAlerts } from '../../components/notifications/PushAlerts';
import { useCan } from '../../core/permissions';
import { messageFor } from '../../forms/errors';
import {
  notificationTarget,
  useMarkAllRead,
  useMarkRead,
  useNotificationList,
  useUnreadCount,
} from '../../lib/notifications';
import { QueryBoundary } from '../../shell/QueryBoundary';

/** Everything the business has told this person, newest first. Tapping one marks it read and opens what it is about. */
export function NotificationsScreen() {
  const query = useNotificationList();
  const unread = useUnreadCount();
  const markRead = useMarkRead();
  const markAll = useMarkAllRead();
  const navigation = useNavigation();
  const toast = useToast();
  const can = useCan();
  const items = query.data?.pages.flatMap((page) => page.items) ?? [];

  async function open(notification: Notification) {
    try {
      if (notification.readAt === null) await markRead.mutateAsync(notification.id);
    } catch (error) {
      toast.error(messageFor(error));
    }
    navigation.push(notificationTarget(notification, can));
  }

  async function readAll() {
    try {
      await markAll.mutateAsync();
    } catch (error) {
      toast.error(messageFor(error));
    }
  }

  return (
    <Stack gap={5}>
      <PageHeader
        title="Notifications"
        description="Alerts about your stock, orders, cash on delivery and reports."
        actions={
          <>
            <Button
              variant="secondary"
              icon="check"
              loading={markAll.isPending}
              disabled={(unread.data ?? 0) === 0}
              onPress={readAll}
            >
              Mark all read
            </Button>
            <Button variant="secondary" icon="sliders" href="/notifications/preferences">
              Preferences
            </Button>
          </>
        }
      />
      <PushAlerts variant="prompt" />
      <QueryBoundary {...query} refetch={() => query.refetch()} label="Loading notifications">
        {items.length === 0 ? (
          <EmptyState icon="bell" title="You are all caught up">
            New alerts appear here when something needs your attention.
          </EmptyState>
        ) : (
          <Stack gap={3}>
            {items.map((n) => (
              <NotificationRow key={n.id} notification={n} onOpen={open} />
            ))}
            <LoadMore
              hasNext={query.hasNextPage}
              loading={query.isFetchingNextPage}
              onPress={() => void query.fetchNextPage()}
            />
          </Stack>
        )}
      </QueryBoundary>
    </Stack>
  );
}
