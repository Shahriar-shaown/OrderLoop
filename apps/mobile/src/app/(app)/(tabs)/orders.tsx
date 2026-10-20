import { OrdersScreen } from '@orderloop/features';
import { useLocalSearchParams } from 'expo-router';
import { ScreenFrame } from '@/chrome/ScreenFrame';

export default function Orders() {
  const { status, from, to } = useLocalSearchParams<{
    status?: string;
    from?: string;
    to?: string;
  }>();
  return (
    <ScreenFrame tab>
      <OrdersScreen initialStatus={status} initialFrom={from} initialTo={to} />
    </ScreenFrame>
  );
}
