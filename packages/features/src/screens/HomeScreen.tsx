import { LoadingState, Screen, useNavigation } from '@orderloop/ui';
import { useEffect } from 'react';
import { useAuth } from '../auth';

/** The front door: signed-in visitors go to their catalog, everyone else to sign in. */
export function HomeScreen() {
  const { status } = useAuth();
  const navigation = useNavigation();
  useEffect(() => {
    if (status === 'authenticated') navigation.replace('/products');
    if (status === 'anonymous') navigation.replace('/login');
  }, [status]);
  return (
    <Screen width="sm">
      <LoadingState label="Loading" />
    </Screen>
  );
}
