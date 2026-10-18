import { LoadingState, Screen, useNavigation } from '@orderloop/ui';
import { useEffect } from 'react';
import { useAuth } from '../auth';
import { useRuntime } from '../runtime';

/** The front door: signed-in visitors go to their catalog, everyone else to sign in. */
export function HomeScreen() {
  const { status } = useAuth();
  const navigation = useNavigation();
  const { home } = useRuntime();
  useEffect(() => {
    if (status === 'authenticated') navigation.replace(home);
    if (status === 'anonymous') navigation.replace('/login');
  }, [status]);
  return (
    <Screen width="sm">
      <LoadingState label="Loading" />
    </Screen>
  );
}
