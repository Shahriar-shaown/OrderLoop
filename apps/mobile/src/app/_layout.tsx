import { useAuth } from '@orderloop/features';
import { useTheme } from '@orderloop/ui';
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

export default function RootLayout() {
  return (
    <Providers>
      <Root />
    </Providers>
  );
}
