import { OrdersImportScreen } from '@orderloop/features';
import { ScreenFrame } from '@/chrome/ScreenFrame';

export default function ImportOrders() {
  return (
    <ScreenFrame title="Import orders">
      <OrdersImportScreen />
    </ScreenFrame>
  );
}
