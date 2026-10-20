import { CustomerDetailScreen } from '@orderloop/features';
import { useLocalSearchParams } from 'expo-router';
import { ScreenFrame } from '@/chrome/ScreenFrame';

export default function CustomerDetail() {
  const { id } = useLocalSearchParams<{ id: string }>();
  return (
    <ScreenFrame title="Customer">
      <CustomerDetailScreen id={id} />
    </ScreenFrame>
  );
}
