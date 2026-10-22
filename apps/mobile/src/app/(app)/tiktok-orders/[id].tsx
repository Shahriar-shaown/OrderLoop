import { TikTokOrderScreen } from '@orderloop/features';
import { useLocalSearchParams } from 'expo-router';
import { ScreenFrame } from '@/chrome/ScreenFrame';

export default function TikTokOrder() {
  const { id } = useLocalSearchParams<{ id: string }>();
  return (
    <ScreenFrame title="TikTok order">
      <TikTokOrderScreen id={id} />
    </ScreenFrame>
  );
}
