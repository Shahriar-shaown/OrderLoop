import { NotificationsScreen } from '@orderloop/features';
import { ScreenFrame } from '@/chrome/ScreenFrame';

export default function Notifications() {
  return (
    <ScreenFrame title="Notifications">
      <NotificationsScreen />
    </ScreenFrame>
  );
}
