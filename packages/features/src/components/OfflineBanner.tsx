import { Alert, Text } from '@orderloop/ui';
import { useOnline } from '../online';

/** Shown while the device is offline: what is on screen is the last thing loaded, and changes cannot be sent. */
export function OfflineBanner() {
  const online = useOnline();
  if (online) return null;
  return (
    <Alert tone="warning">
      <Text weight="semibold">You are offline.</Text>
      <Text>
        You can read what is already loaded. Changes, such as orders, payments and courier bookings,
        are not sent until you are back online.
      </Text>
    </Alert>
  );
}
