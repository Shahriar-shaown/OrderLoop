import {
  NotificationData,
  type AutomationKind,
  type Notification,
  type Permission,
} from '@orderloop/contracts';
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useAuth } from '../core/auth';
import { useApi } from '../core/runtime';
import { invalidateKeys } from './invalidate';

/** How often the bell asks the server for the unread count while the app is open and in front. */
export const UNREAD_POLL_MS = 60_000;

/** The unread count the bell shows. Polled every minute while in front, and asked again when the person comes back. */
export function useUnreadCount() {
  const api = useApi();
  const { status } = useAuth();
  return useQuery({
    queryKey: ['notifications', 'unread-count'],
    enabled: status === 'authenticated',
    queryFn: async () => (await api.notifications.unreadCount()).count,
    refetchInterval: UNREAD_POLL_MS,
    refetchIntervalInBackground: false,
    // Always ask again on return (the default only does when the cached answer is older than a few seconds).
    refetchOnWindowFocus: 'always',
    staleTime: 0,
  });
}

/** The person's notifications, newest first, a page at a time. */
export function useNotificationList() {
  const api = useApi();
  return useInfiniteQuery({
    queryKey: ['notifications', 'list'],
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }) =>
      api.notifications.list({ ...(pageParam ? { cursor: pageParam } : {}) }),
    getNextPageParam: (page) => page.nextCursor ?? undefined,
  });
}

/** Refresh the bell and the list (after reading, after a run that made notifications, when a push arrives). */
export const invalidateNotifications = (client: ReturnType<typeof useQueryClient>) =>
  invalidateKeys(client, ['notifications']);

/** Mark one notification read; resolves with the notification, which is what a tapped push needs to find its screen. */
export function useMarkRead() {
  const api = useApi();
  const client = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.notifications.markRead(id),
    onSuccess: () => invalidateNotifications(client),
  });
}

export function useMarkAllRead() {
  const api = useApi();
  const client = useQueryClient();
  return useMutation({
    mutationFn: () => api.notifications.markAllRead(),
    onSuccess: () => invalidateNotifications(client),
  });
}

const OPEN_ORDER = (id: string) => `/orders/${encodeURIComponent(id)}`;

/**
 * The screen a notification opens: its order when it is about exactly one, else the list that shows what it is about.
 * Only ids and counts travel in `data`; an unreadable `data` still opens the right kind of screen.
 */
export function notificationTarget(
  notification: Pick<Notification, 'kind' | 'data'>,
  can: (permission: Permission) => boolean,
): string {
  const parsed = NotificationData.partial().safeParse(notification.data);
  const data = parsed.success ? parsed.data : {};
  const only =
    data.orderIds?.length === 1 && (data.count ?? 1) === 1 ? data.orderIds[0] : undefined;
  const kind: AutomationKind = notification.kind;
  switch (kind) {
    case 'LOW_STOCK':
      return '/products?tab=low';
    case 'NEW_ORDER':
    case 'DELAYED_ORDER':
      return only ? OPEN_ORDER(only) : '/orders';
    case 'UNCONFIRMED_ORDER':
      return only ? OPEN_ORDER(only) : '/orders?status=pending_confirmation';
    case 'COD_DISCREPANCY':
      return '/cod';
    case 'DAILY_REPORT':
      return '/dashboard';
    case 'WEEKLY_REPORT':
      return can('finance:read') ? '/analytics' : '/dashboard';
  }
}

// ---- the person's own choices -------------------------------------------------------------------------------------------

export function useNotificationPreferences() {
  const api = useApi();
  return useQuery({
    queryKey: ['notification-preferences'],
    queryFn: async () => (await api.notifications.preferences()).items,
  });
}

export type PreferenceChange = { kind: AutomationKind } & Partial<
  Record<'inApp' | 'push' | 'email', boolean>
>;

/** Save a change to one kind's channels; the answer (every kind, as now stored) replaces what is on screen. */
export function useSavePreference() {
  const api = useApi();
  const client = useQueryClient();
  return useMutation({
    mutationFn: (change: PreferenceChange) => api.notifications.updatePreferences([change]),
    onSuccess: (saved) => client.setQueryData(['notification-preferences'], saved.items),
  });
}

/** The person's consent to texts and WhatsApp messages, with whether this server can send each at all. */
export function useMessagingConsents() {
  const api = useApi();
  return useQuery({
    queryKey: ['messaging-consents'],
    queryFn: async () => (await api.messagingConsents.get()).items,
  });
}
