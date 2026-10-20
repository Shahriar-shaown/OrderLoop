import { InventoryScreen } from '@orderloop/features';
import { ScreenFrame } from '@/chrome/ScreenFrame';

export default function Inventory() {
  return (
    <ScreenFrame title="Inventory">
      <InventoryScreen />
    </ScreenFrame>
  );
}
