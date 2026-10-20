import { ResetPasswordScreen } from '@orderloop/features';
import { useLocalSearchParams } from 'expo-router';

export default function ResetPassword() {
  const { token } = useLocalSearchParams<{ token?: string }>();
  return <ResetPasswordScreen token={token} />;
}
