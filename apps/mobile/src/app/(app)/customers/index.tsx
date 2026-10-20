import { CustomersScreen } from '@orderloop/features';
import { ScreenFrame } from '@/chrome/ScreenFrame';

export default function Customers() {
  return (
    <ScreenFrame title="Customers">
      <CustomersScreen />
    </ScreenFrame>
  );
}
