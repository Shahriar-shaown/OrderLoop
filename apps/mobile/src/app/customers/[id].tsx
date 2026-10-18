import { CustomerDetailScreen } from '@orderloop/features';
import { useLocalSearchParams } from 'expo-router';
import { Shell } from '@/lib/Shell';

export default function CustomerDetail() {
  const { id } = useLocalSearchParams<{ id: string }>();
  return (
    <Shell>
      <CustomerDetailScreen id={id} />
    </Shell>
  );
}
