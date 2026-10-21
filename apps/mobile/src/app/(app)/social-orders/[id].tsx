import { SocialDraftScreen } from '@orderloop/features';
import { useLocalSearchParams } from 'expo-router';
import { ScreenFrame } from '@/chrome/ScreenFrame';

export default function SocialDraft() {
  const { id } = useLocalSearchParams<{ id: string }>();
  return (
    <ScreenFrame title="Review draft order">
      <SocialDraftScreen id={id} />
    </ScreenFrame>
  );
}
