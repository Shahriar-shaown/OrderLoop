import { CustomersScreen } from '@orderloop/features';
import { useLocalSearchParams } from 'expo-router';
import { ScreenFrame } from '@/chrome/ScreenFrame';

export default function Customers() {
  const { new: openNew } = useLocalSearchParams<{ new?: string }>();
  return (
    <ScreenFrame title="Customers">
      <CustomersScreen openNew={openNew === '1'} />
    </ScreenFrame>
  );
}
