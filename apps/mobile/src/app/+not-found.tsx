import { Button, EmptyState, useNavigation } from '@orderloop/ui';
import { View } from 'react-native';

/** A link or a typed address that matches no screen: say so and offer the way home. */
export default function NotFound() {
  const navigation = useNavigation();
  return (
    <View style={{ flex: 1, justifyContent: 'center', padding: 24 }}>
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
