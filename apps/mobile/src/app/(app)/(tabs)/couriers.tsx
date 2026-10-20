import { ShipmentsScreen } from '@orderloop/features';
import { ScreenFrame } from '@/chrome/ScreenFrame';

export default function Screen() {
  return (
    <ScreenFrame tab>
      <ShipmentsScreen />
    </ScreenFrame>
  );
}
