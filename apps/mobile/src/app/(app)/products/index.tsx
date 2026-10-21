import { ProductsScreen } from '@orderloop/features';
import { useLocalSearchParams } from 'expo-router';
import { ScreenFrame } from '@/chrome/ScreenFrame';

export default function Products() {
  // A notification opens the low-stock list with `?tab=low`.
  const { tab } = useLocalSearchParams<{ tab?: string }>();
  return (
    <ScreenFrame title="Products & inventory">
      <ProductsScreen tab={tab} />
    </ScreenFrame>
  );
}
