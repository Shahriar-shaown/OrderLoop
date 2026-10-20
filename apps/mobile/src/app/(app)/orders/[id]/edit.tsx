import { EditOrderScreen } from '@orderloop/features';
import { useLocalSearchParams } from 'expo-router';
import { ScreenFrame } from '@/chrome/ScreenFrame';

export default function EditOrder() {
  const { id } = useLocalSearchParams<{ id: string }>();
  return (
    <ScreenFrame title="Edit order">
      <EditOrderScreen id={id} />
    </ScreenFrame>
  );
}
