import { SettlementDetailScreen } from '@orderloop/features';
import { useLocalSearchParams } from 'expo-router';
import { ScreenFrame } from '@/chrome/ScreenFrame';

export default function Settlement() {
  const { id } = useLocalSearchParams<{ id: string }>();
  return (
    <ScreenFrame title="Settlement">
      <SettlementDetailScreen id={id} />
    </ScreenFrame>
  );
}
