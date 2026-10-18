import { EditOrderScreen } from '@orderloop/features';
import { useLocalSearchParams } from 'expo-router';
import { Shell } from '@/lib/Shell';

export default function EditOrder() {
  const { id } = useLocalSearchParams<{ id: string }>();
  return (
    <Shell>
      <EditOrderScreen id={id} />
    </Shell>
  );
}
