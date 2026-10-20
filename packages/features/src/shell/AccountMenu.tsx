import {
  Avatar,
  Button,
  Popover,
  Text,
  ThemeToggle,
  MenuRow,
  initials,
  useTheme,
} from '@orderloop/ui';
import { Pressable, View } from 'react-native';
import { useAuth } from '../core/auth';

/** The person's avatar, opening their account: name, email, the colour theme, settings and sign out. */
export function AccountMenu({ onSignOut, leaving }: { onSignOut: () => void; leaving: boolean }) {
  const { session } = useAuth();
  const { colors } = useTheme();
  if (!session) return null;
  return (
    <Popover
      triggerAlign="center"
      align="end"
      width={280}
      trigger={(p) => (
        <Pressable
          role="button"
          aria-label={`${initials(session.user.name)} Account menu`}
          aria-haspopup="menu"
          aria-expanded={p['aria-expanded']}
          onPress={p.onPress}
          style={{ minHeight: 44, minWidth: 44, alignItems: 'center', justifyContent: 'center' }}
        >
          <Avatar name={session.user.name} size={32} />
        </Pressable>
      )}
    >
      {(close) => (
        <View style={{ gap: 4 }}>
          <View style={{ paddingHorizontal: 12, paddingVertical: 8 }}>
            <Text variant="label" numberOfLines={1}>
              {session.user.name}
            </Text>
            <Text variant="caption" tone="muted" numberOfLines={1} testID="user-email">
              {session.user.email}
            </Text>
          </View>
          <View role="separator" style={{ height: 1, backgroundColor: colors.border }} />
          <View style={{ paddingHorizontal: 12, paddingVertical: 8, gap: 6 }}>
            <Text variant="fine" tone="muted">
              Colour theme
            </Text>
            <ThemeToggle />
          </View>
          <View role="separator" style={{ height: 1, backgroundColor: colors.border }} />
          <MenuRow
            item={{
              key: 'settings',
              label: 'Business settings',
              icon: 'sliders',
              href: '/settings',
            }}
            onDone={close}
          />
          <View style={{ padding: 8 }}>
            <Button
              variant="secondary"
              fullWidth
              icon="logout"
              loading={leaving}
              onPress={onSignOut}
            >
              Sign out
            </Button>
          </View>
        </View>
      )}
    </Popover>
  );
}
