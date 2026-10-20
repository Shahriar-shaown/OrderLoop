import { NewOrderScreen } from '@orderloop/features';
import { useLocalSearchParams } from 'expo-router';
import { ScreenFrame } from '@/chrome/ScreenFrame';

export default function NewOrder() {
  const { customerId } = useLocalSearchParams<{ customerId?: string }>();
  return (
    <ScreenFrame title="Create order">
      <NewOrderScreen customerId={customerId} />
    </ScreenFrame>
  );
}
