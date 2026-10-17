import { ThemeProvider, ToastProvider } from '@orderloop/ui';
import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';

export default function RootLayout() {
  return (
    <ThemeProvider>
      <ToastProvider>
        <StatusBar style="auto" />
        <Stack screenOptions={{ headerShown: false }} />
      </ToastProvider>
    </ThemeProvider>
  );
}
