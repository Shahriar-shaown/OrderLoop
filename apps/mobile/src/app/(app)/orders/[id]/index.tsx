import { OrderDetailScreen } from '@orderloop/features';
import { useLocalSearchParams } from 'expo-router';
import { ScreenFrame } from '@/chrome/ScreenFrame';

export default function OrderDetail() {
  const { id } = useLocalSearchParams<{ id: string }>();
  return (
    <ScreenFrame title="Order">
      <OrderDetailScreen id={id} />
    </ScreenFrame>
  );
}
