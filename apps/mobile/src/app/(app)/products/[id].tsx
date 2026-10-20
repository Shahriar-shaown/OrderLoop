import { ProductDetailScreen } from '@orderloop/features';
import { useLocalSearchParams } from 'expo-router';
import { ScreenFrame } from '@/chrome/ScreenFrame';

export default function ProductDetail() {
  const { id } = useLocalSearchParams<{ id: string }>();
  return (
    <ScreenFrame title="Product">
      <ProductDetailScreen id={id} />
    </ScreenFrame>
  );
}
