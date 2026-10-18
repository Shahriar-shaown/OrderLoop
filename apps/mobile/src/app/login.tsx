import { LoginScreen } from '@orderloop/features';
import { useLocalSearchParams } from 'expo-router';

export default function Login() {
  const { next } = useLocalSearchParams<{ next?: string }>();
  return <LoginScreen next={next} />;
}
