import { OrderDetailScreen } from '@orderloop/features';
import { useLocalSearchParams } from 'expo-router';
import { Shell } from '@/lib/Shell';

export default function OrderDetail() {
  const { id } = useLocalSearchParams<{ id: string }>();
  return (
    <Shell>
      <OrderDetailScreen id={id} />
    </Shell>
  );
}
