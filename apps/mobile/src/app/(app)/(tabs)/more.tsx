import { useSignOut } from '@orderloop/features';
import { MoreScreen } from '@/chrome/MoreScreen';
import { ScreenFrame } from '@/chrome/ScreenFrame';

export default function More() {
  const { signOut } = useSignOut();
  return (
    <ScreenFrame tab verify>
      <MoreScreen onSignOut={signOut} />
    </ScreenFrame>
  );
}
