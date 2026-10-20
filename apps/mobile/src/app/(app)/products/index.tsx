import { ProductsScreen } from '@orderloop/features';
import { ScreenFrame } from '@/chrome/ScreenFrame';

export default function Products() {
  return (
    <ScreenFrame title="Products & inventory">
      <ProductsScreen />
    </ScreenFrame>
  );
}
