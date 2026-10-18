import { SettlementDetailScreen } from '@orderloop/features';
import { useLocalSearchParams } from 'expo-router';
import { Shell } from '@/lib/Shell';

export default function Settlement() {
  const { id } = useLocalSearchParams<{ id: string }>();
  return (
    <Shell>
      <SettlementDetailScreen id={id} />
    </Shell>
  );
}
