import { AcceptInvitationScreen } from '@orderloop/features';
import { useLocalSearchParams } from 'expo-router';

export default function AcceptInvitation() {
  const { token } = useLocalSearchParams<{ token?: string }>();
  return <AcceptInvitationScreen token={token} />;
}
