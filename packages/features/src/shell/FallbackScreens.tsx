import { Button, EmptyState, useNavigation } from '@orderloop/ui';
import { View } from 'react-native';

const frame = { flex: 1, justifyContent: 'center', padding: 24 } as const;

/** A link or a typed address that matches no screen: say so and offer the way home. */
export function NotFoundScreen() {
  const navigation = useNavigation();
  return (
    <View style={frame}>
      <EmptyState
        icon="search"
        title="This page does not exist"
        action={<Button onPress={() => navigation.replace('/')}>Go to the start</Button>}
      >
        The link may be out of date, or meant for a newer version of the app.
      </EmptyState>
    </View>
  );
}

/** What each app shows when a screen throws while rendering: an apology and a way to try again, not a blank screen. */
export function CrashScreen({ retry }: { retry: () => void }) {
  return (
    <View style={frame}>
      <EmptyState
        icon="alert"
        title="Something went wrong"
        action={<Button onPress={retry}>Try again</Button>}
      >
        The app hit an unexpected problem. Nothing you saved was lost.
      </EmptyState>
    </View>
  );
}
