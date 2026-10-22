import { TikTokOrdersScreen } from '@orderloop/features';
import { ScreenFrame } from '@/chrome/ScreenFrame';

export default function TikTokOrders() {
  return (
    <ScreenFrame title="TikTok orders">
      <TikTokOrdersScreen />
    </ScreenFrame>
  );
}
