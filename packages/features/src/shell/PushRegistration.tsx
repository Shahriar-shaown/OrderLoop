import { useNavigation, useToast } from '@orderloop/ui';
import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { useAuth } from '../core/auth';
import { useCan } from '../core/permissions';
import type { PushMessage } from '../core/push';
import { useApi, useRuntime } from '../core/runtime';
import { KIND_INFO } from '../lib/automation';
import { invalidateNotifications, notificationTarget } from '../lib/notifications';
import { AutomationKind } from '@orderloop/contracts';

/**
 * Keeps this phone registered for push while someone is signed in, shows a pushed notification that arrives while the app is
 * open, and opens the right screen when one is tapped (once the person is signed in). It draws nothing, and on the web, where
 * there is no push, it does nothing.
 */
export function PushRegistration() {
  const { push } = useRuntime();
  const { status, session } = useAuth();
  const api = useApi();
  const can = useCan();
  const client = useQueryClient();
  const toast = useToast();
  const navigation = useNavigation();
  const userId = session?.user.id;
  const [tapped, setTapped] = useState<PushMessage | null>(null);
  // The listeners below are set up once; they read the latest of these.
  const latest = useRef({ can, navigation, toast });
  latest.current = { can, navigation, toast };

  useEffect(() => {
    if (!push || status !== 'authenticated') return;
    void push.sync();
    return push.platform.onTokenChange(() => void push.sync());
  }, [push, status, userId]);

  useEffect(() => {
    if (!push) return;
    const stopReceived = push.platform.onReceived((message) => {
      void invalidateNotifications(client);
      const kind = AutomationKind.safeParse(message.kind);
      latest.current.toast.info(
        kind.success ? `New notification: ${KIND_INFO[kind.data].name}` : 'New notification',
      );
    });
    // A tap can arrive before the session is restored (the app was closed): keep it until there is someone to show it to.
    const stopOpened = push.platform.onOpened(setTapped);
    return () => {
      stopReceived();
      stopOpened();
    };
  }, [push, client]);

  useEffect(() => {
    if (!tapped || status !== 'authenticated') return;
    setTapped(null);
    void (async () => {
      try {
        // Reading it returns it, which says where it leads; the push itself only carried the kind and the id.
        const notification = await api.notifications.markRead(tapped.id);
        void invalidateNotifications(client);
        latest.current.navigation.push(notificationTarget(notification, latest.current.can));
      } catch {
        latest.current.navigation.push('/notifications');
      }
    })();
  }, [tapped, status, api, client]);

  return null;
}
