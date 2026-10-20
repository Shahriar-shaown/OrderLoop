import { OfflineBanner, useRefreshAll, VerifyBanner } from '@orderloop/features';
import {
  Container,
  ScreenChromeProvider,
  Stack as Column,
  useKeyboardInset,
  useT,
  useTheme,
} from '@orderloop/ui';
import { Stack } from 'expo-router';
import { useCallback, useState, type ReactNode } from 'react';
import { Platform, RefreshControl, ScrollView } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

/**
 * The frame of every signed-in screen: a scrolling page that keeps clear of the notch, home indicator and keyboard, pulls to
 * refresh, and says when the device is offline.
 *
 * A screen with a `title` is pushed on the navigation stack: the title (and the back button) live in the native bar, so the
 * shared screen leaves its own title out. A tab screen (`tab`) has the app header above it instead.
 */
export function ScreenFrame({
  title,
  tab = false,
  verify = false,
  children,
}: {
  title?: string;
  tab?: boolean;
  /** Show the e-mail verification reminder (only where it is worth the room: Home and More). */
  verify?: boolean;
  children: ReactNode;
}) {
  const insets = useSafeAreaInsets();
  const keyboard = useKeyboardInset();
  const { colors } = useTheme();
  const t = useT();
  const [barTitle, setBarTitle] = useState<string | undefined>(undefined);
  const refreshAll = useRefreshAll();
  const [refreshing, setRefreshing] = useState(false);
  const onRefresh = useCallback(() => {
    setRefreshing(true);
    void refreshAll().finally(() => setRefreshing(false));
  }, [refreshAll]);
  return (
    <ScreenChromeProvider titleInBar={title !== undefined} onTitle={setBarTitle}>
      {title !== undefined && <Stack.Screen options={{ title: t(barTitle ?? title) }} />}
      <ScrollView
        style={{ flex: 1, backgroundColor: colors.background }}
        contentContainerStyle={{
          flexGrow: 1,
          paddingBottom: (tab ? 16 : insets.bottom + 24) + keyboard,
        }}
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode={Platform.OS === 'ios' ? 'interactive' : 'on-drag'}
        automaticallyAdjustKeyboardInsets
        contentInsetAdjustmentBehavior="never"
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={onRefresh}
            tintColor={colors.primary}
            colors={[colors.primary]}
          />
        }
      >
        <Container role="main" width="full">
          <Column gap={5}>
            <OfflineBanner />
            {verify && <VerifyBanner />}
            {children}
          </Column>
        </Container>
      </ScrollView>
    </ScreenChromeProvider>
  );
}
