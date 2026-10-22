import { AccountScreen } from '@orderloop/features';
import { ScreenFrame } from '@/chrome/ScreenFrame';

export default function Account() {
  return (
    <ScreenFrame title="Your account">
      <AccountScreen />
    </ScreenFrame>
  );
}
