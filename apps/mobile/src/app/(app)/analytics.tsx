import { AnalyticsScreen } from '@orderloop/features';
import { ScreenFrame } from '@/chrome/ScreenFrame';

export default function Screen() {
  return (
    <ScreenFrame title="Analytics & profit">
      <AnalyticsScreen />
    </ScreenFrame>
  );
}
