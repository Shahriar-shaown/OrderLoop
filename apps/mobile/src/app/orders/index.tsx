import { OrdersScreen } from '@orderloop/features';
import { useLocalSearchParams } from 'expo-router';
import { Shell } from '@/lib/Shell';

export default function Orders() {
  const { status, from, to } = useLocalSearchParams<{
    status?: string;
    from?: string;
    to?: string;
  }>();
  return (
    <Shell>
      <OrdersScreen initialStatus={status} initialFrom={from} initialTo={to} />
    </Shell>
  );
}
