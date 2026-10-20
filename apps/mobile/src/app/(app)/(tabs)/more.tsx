import { useAuth } from '@orderloop/features';
import { useNavigation } from '@orderloop/ui';
import { MoreScreen } from '@/chrome/MoreScreen';
import { ScreenFrame } from '@/chrome/ScreenFrame';

export default function More() {
  const { signOut } = useAuth();
  const navigation = useNavigation();
  return (
    <ScreenFrame tab verify>
      <MoreScreen
        onSignOut={async () => {
          await signOut();
          navigation.replace('/login');
        }}
      />
    </ScreenFrame>
  );
}
