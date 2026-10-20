import { GlobalSearch, WorkspaceMenu, useAuth } from '@orderloop/features';
import { Avatar, Button, useNavigation, useTheme } from '@orderloop/ui';
import { useState } from 'react';
import { Pressable, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

/** The header of the tab screens: the business (tap to switch), search, and the person's profile. */
export function MobileHeader() {
  const insets = useSafeAreaInsets();
  const { colors } = useTheme();
  const { session } = useAuth();
  const navigation = useNavigation();
  const [searching, setSearching] = useState(false);
  return (
    <View
      style={{
        paddingTop: insets.top + 6,
        paddingBottom: 6,
        paddingHorizontal: 12,
        flexDirection: 'row',
        alignItems: 'center',
        gap: 6,
        backgroundColor: colors.surface,
        borderBottomWidth: 1,
        borderBottomColor: colors.border,
      }}
    >
      <View style={{ flexShrink: 1, minWidth: 0 }}>
        <WorkspaceMenu />
      </View>
      <View style={{ flexGrow: 1 }} />
      <Button
        variant="ghost"
        icon="search"
        accessibilityLabel="Search"
        onPress={() => setSearching(true)}
      />
      {session && (
        <Pressable
          role="button"
          aria-label="Profile"
          onPress={() => navigation.push('/more')}
          style={{ minHeight: 44, minWidth: 44, alignItems: 'center', justifyContent: 'center' }}
        >
          <Avatar name={session.user.name} size={32} />
        </Pressable>
      )}
      <GlobalSearch open={searching} onClose={() => setSearching(false)} />
    </View>
  );
}
