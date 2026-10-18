import { ProductDetailScreen } from '@orderloop/features';
import { useLocalSearchParams } from 'expo-router';
import { Shell } from '@/lib/Shell';

export default function ProductDetail() {
  const { id } = useLocalSearchParams<{ id: string }>();
  return (
    <Shell>
      <ProductDetailScreen id={id} />
    </Shell>
  );
}
