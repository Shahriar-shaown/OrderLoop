import { useAuth } from '@orderloop/features';
import { Button, EmptyState, ThemeProvider, useTheme } from '@orderloop/ui';
import { View } from 'react-native';
import { Stack } from 'expo-router';
import * as SplashScreen from 'expo-splash-screen';
import { StatusBar } from 'expo-status-bar';
import * as SystemUI from 'expo-system-ui';
import { useEffect } from 'react';
import { Providers } from '@/platform/Providers';

// Keep the splash screen up until we know whether there is a session to restore: no flash of the sign-in screen.
void SplashScreen.preventAutoHideAsync();

/** The root navigator, in the app's colours (light or dark) from the first frame to the last. */
function Root() {
  const { status, restoreFailed } = useAuth();
  const { scheme, colors } = useTheme();

  useEffect(() => {
    if (status !== 'loading' || restoreFailed) void SplashScreen.hideAsync();
  }, [status, restoreFailed]);

  // The window itself (behind every screen, and showing while the keyboard resizes the app) follows the theme too.
  useEffect(() => {
    void SystemUI.setBackgroundColorAsync(colors.background);
  }, [colors.background]);

  return (
    <>
      <StatusBar style={scheme === 'dark' ? 'light' : 'dark'} />
      <Stack
        screenOptions={{ headerShown: false, contentStyle: { backgroundColor: colors.background } }}
      />
    </>
  );
}

/** What expo-router shows when a screen throws while rendering: an apology and a way to try again, not a blank screen. */
export function ErrorBoundary({ retry }: { error: Error; retry: () => Promise<void> }) {
  // Rendered in place of the whole app, so outside the providers: it brings its own theme.
  return (
    <ThemeProvider>
      <View style={{ flex: 1, justifyContent: 'center', padding: 24 }}>
        <EmptyState
          icon="alert"
          title="Something went wrong"
          action={<Button onPress={() => void retry()}>Try again</Button>}
        >
          The app hit an unexpected problem. Nothing you saved was lost.
        </EmptyState>
      </View>
    </ThemeProvider>
  );
}

export default function RootLayout() {
  return (
    <Providers>
      <Root />
    </Providers>
  );
}
