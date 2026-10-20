import { VerifyEmailScreen } from '@orderloop/features';
import { useLocalSearchParams } from 'expo-router';

export default function VerifyEmail() {
  const { token } = useLocalSearchParams<{ token?: string }>();
  return <VerifyEmailScreen token={token} />;
}
