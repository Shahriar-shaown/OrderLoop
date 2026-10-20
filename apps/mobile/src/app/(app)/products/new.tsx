import { NewProductScreen } from '@orderloop/features';
import { ScreenFrame } from '@/chrome/ScreenFrame';

export default function NewProduct() {
  return (
    <ScreenFrame title="New product">
      <NewProductScreen />
    </ScreenFrame>
  );
}
