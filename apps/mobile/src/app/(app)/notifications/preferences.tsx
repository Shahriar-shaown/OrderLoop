import { NotificationPreferencesScreen } from '@orderloop/features';
import { ScreenFrame } from '@/chrome/ScreenFrame';

export default function NotificationPreferences() {
  return (
    <ScreenFrame title="Notification preferences">
      <NotificationPreferencesScreen />
    </ScreenFrame>
  );
}
