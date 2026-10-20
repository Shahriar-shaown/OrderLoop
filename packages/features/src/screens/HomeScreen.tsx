import { LoadingState, Logo, Screen, Stack, useNavigation } from '@orderloop/ui';
import { useEffect } from 'react';
import { useAuth } from '../auth';
import { RestoreFailed } from '../components/RestoreFailed';
import { useRuntime } from '../runtime';

/** The front door: signed-in visitors go to their catalog, everyone else to sign in. */
export function HomeScreen() {
  const { status, restoreFailed } = useAuth();
  const navigation = useNavigation();
  const { home } = useRuntime();
  useEffect(() => {
    if (status === 'authenticated') navigation.replace(home);
    if (status === 'anonymous') navigation.replace('/login');
  }, [status]);
  if (restoreFailed)
    return (
      <Screen width="sm">
        <RestoreFailed />
      </Screen>
    );
  return (
    <Screen width="sm">
      <Stack gap={6} align="center">
        <Logo size={36} />
        <LoadingState label="Loading" />
      </Stack>
    </Screen>
  );
}
