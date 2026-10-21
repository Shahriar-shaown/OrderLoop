import { Alert, Button, Row, Section, Text, useToast } from '@orderloop/ui';
import { useCallback, useEffect, useState } from 'react';
import type { PushPermission } from '../../core/push';
import { useRuntime } from '../../core/runtime';

/** Whether this phone may show notifications, and the way to ask. Absent (`null`) on the web, where there is no push. */
function usePushPermission() {
  const { push } = useRuntime();
  const toast = useToast();
  const [permission, setPermission] = useState<PushPermission | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    let current = true;
    if (!push?.platform.supported) return;
    void push.platform.permission().then(
      (p) => current && setPermission(p),
      () => undefined,
    );
    return () => {
      current = false;
    };
  }, [push]);
  const enable = useCallback(async () => {
    if (!push) return;
    setBusy(true);
    try {
      const answer = await push.enable();
      setPermission(answer);
      if (answer === 'granted') toast.success('Alerts are on for this phone.');
    } finally {
      setBusy(false);
    }
  }, [push, toast]);
  return { available: push?.platform.supported === true, permission, busy, enable };
}

/**
 * Turning on alerts for this phone. `prompt` is the one-time explanation shown above the notifications until the person
 * chooses (the system's question comes only after they press "Turn on", never at start-up); `status` is the always-there
 * section in the notification preferences. Both draw nothing on the web.
 */
export function PushAlerts({ variant }: { variant: 'prompt' | 'status' }) {
  const { available, permission, busy, enable } = usePushPermission();
  const [later, setLater] = useState(false);
  if (!available || permission === null) return null;

  if (variant === 'prompt') {
    if (permission !== 'undetermined' || later) return null;
    return (
      <Alert
        tone="info"
        icon="bell"
        title="Get alerts on this phone"
        action={
          <Row gap={2} wrap>
            <Button size="sm" loading={busy} onPress={enable}>
              Turn on
            </Button>
            <Button size="sm" variant="secondary" onPress={() => setLater(true)}>
              Not now
            </Button>
          </Row>
        }
      >
        <Text>
          We can tell you when stock runs low or an order needs you, even when the app is closed.
          You can change this any time in Notification preferences.
        </Text>
      </Alert>
    );
  }

  return (
    <Section
      title="This phone"
      description="Alerts that arrive on this phone while the app is closed. Which alerts you get is chosen below."
    >
      {permission === 'granted' ? (
        <Alert tone="success">Alerts are on for this phone.</Alert>
      ) : permission === 'denied' ? (
        <Alert tone="warning">
          Notifications are off for OrderLoop in your phone’s settings. Turn them on there to get
          alerts on this phone.
        </Alert>
      ) : (
        <Row>
          <Button icon="bell" loading={busy} onPress={enable}>
            Turn on alerts
          </Button>
        </Row>
      )}
    </Section>
  );
}
