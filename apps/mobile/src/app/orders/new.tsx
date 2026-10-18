import { NewOrderScreen } from '@orderloop/features';
import { useLocalSearchParams } from 'expo-router';
import { Shell } from '@/lib/Shell';

export default function NewOrder() {
  const { customerId } = useLocalSearchParams<{ customerId?: string }>();
  return (
    <Shell>
      <NewOrderScreen customerId={customerId} />
    </Shell>
  );
}
