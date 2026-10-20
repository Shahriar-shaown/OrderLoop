import { Alert, Button, Logo, Stack, Text } from '@orderloop/ui';
import { View } from 'react-native';
import { useAuth } from '../auth';

/**
 * Shown instead of the loading spinner when the app was opened without a connection and so could not restore the saved
 * session. Nothing is lost: the session is still on the device, and Try again picks it up.
 */
export function RestoreFailed() {
  const { retryRestore } = useAuth();
  return (
    <Stack align="center" gap={5} style={{ paddingTop: 80, paddingHorizontal: 24 }}>
      <Logo size={36} />
      <View style={{ alignSelf: 'stretch' }}>
        <Alert tone="warning">
          <Text weight="semibold">Cannot reach OrderLoop.</Text>
          <Text>Check your connection. You stay signed in; nothing was lost.</Text>
        </Alert>
      </View>
      <Button onPress={retryRestore}>Try again</Button>
    </Stack>
  );
}
