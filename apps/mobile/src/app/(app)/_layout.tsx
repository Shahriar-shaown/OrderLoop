import { RestoreFailed, useAuth, useRequireAuth } from '@orderloop/features';
import { Logo, Spinner, Stack as Column, useTheme } from '@orderloop/ui';
import { Stack } from 'expo-router';
import { View } from 'react-native';

/**
 * Everything behind sign-in. While the session is being restored (or the person is being sent to sign in) nothing private is
 * shown. Pushed screens get a native bar with a back button and a title; the tabs bring their own header.
 */
export default function AppLayout() {
  const { status } = useRequireAuth();
  const { restoreFailed } = useAuth();
  const { colors } = useTheme();
  if (restoreFailed)
    return (
      <View style={{ flex: 1, backgroundColor: colors.background }}>
        <RestoreFailed />
      </View>
    );
  if (status !== 'authenticated')
    return (
      <View
        style={{
          flex: 1,
          alignItems: 'center',
          justifyContent: 'center',
          backgroundColor: colors.background,
        }}
      >
        <Column align="center" gap={4}>
          <Logo />
          <Spinner />
        </Column>
      </View>
    );
  return (
    <Stack
      screenOptions={{
        headerStyle: { backgroundColor: colors.surface },
        headerTintColor: colors.primary,
        headerTitleStyle: { color: colors.foreground, fontWeight: '600' },
        headerBackButtonDisplayMode: 'minimal',
        headerShadowVisible: false,
        contentStyle: { backgroundColor: colors.background },
      }}
    >
      <Stack.Screen name="(tabs)" options={{ headerShown: false }} />
    </Stack>
  );
}
