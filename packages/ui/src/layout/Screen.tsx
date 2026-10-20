import type { ReactNode } from 'react';
import { Platform, ScrollView } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Container } from './Container';
import { useTheme } from '../theme/theme';
import { useKeyboardInset } from './useKeyboardInset';

/**
 * Native implementation: a scrolling screen that keeps clear of the notch, the home indicator and the keyboard, and
 * dismisses the keyboard when the list is dragged. (The web page scrolls by itself, see Screen.web.tsx.)
 */
export function Screen({
  children,
  width,
}: {
  children: ReactNode;
  width?: 'sm' | 'md' | 'lg' | 'full';
}) {
  const insets = useSafeAreaInsets();
  const { colors } = useTheme();
  const keyboard = useKeyboardInset();
  return (
    <ScrollView
      // The screen paints its own page colour: without it the window's (light) background shows through in dark mode.
      style={{ flex: 1, backgroundColor: colors.background }}
      keyboardShouldPersistTaps="handled"
      keyboardDismissMode={Platform.OS === 'ios' ? 'interactive' : 'on-drag'}
      automaticallyAdjustKeyboardInsets
      contentContainerStyle={{
        flexGrow: 1,
        paddingTop: insets.top,
        paddingBottom: insets.bottom + keyboard,
      }}
    >
      <Container role="main" nativeID="main" {...(width ? { width } : {})}>
        {children}
      </Container>
    </ScrollView>
  );
}
