import {
  Avatar,
  Icon,
  Popover,
  Row,
  Text,
  useNavigation,
  useTheme,
  useToast,
  MenuRow,
  useT,
} from '@orderloop/ui';
import { Pressable, View } from 'react-native';
import { useAuth } from '../core/auth';
import { messageFor } from '../forms/errors';
import { useRuntime } from '../core/runtime';
import { useSwitchWorkspace, useWorkspaces } from '../lib/workspaces';

/** The business you are working in, as a button that opens the list of your businesses. */
export function WorkspaceMenu({ compact = false }: { compact?: boolean }) {
  const { session } = useAuth();
  const { home } = useRuntime();
  const query = useWorkspaces();
  const switchTo = useSwitchWorkspace();
  const navigation = useNavigation();
  const toast = useToast();
  const { colors } = useTheme();
  const t = useT();
  if (!session) return null;
  const many = (query.data?.length ?? 0) > 1;
  return (
    <Popover
      triggerAlign="center"
      align="start"
      width={280}
      trigger={(p) => (
        <Pressable
          role="button"
          aria-label={`${session.tenant.name} ${t(session.role.charAt(0) + session.role.slice(1).toLowerCase())}. ${t('Switch business')}`}
          aria-haspopup="menu"
          aria-expanded={p['aria-expanded']}
          onPress={p.onPress}
          style={(state) => [
            {
              flexDirection: 'row',
              alignItems: 'center',
              gap: 10,
              minHeight: 44,
              paddingHorizontal: 10,
              borderRadius: 10,
              borderWidth: 1,
              borderColor: colors.border,
              backgroundColor: colors.surface,
              maxWidth: 260,
            },
            (state as { hovered?: boolean }).hovered ? { backgroundColor: colors.subtle } : null,
          ]}
        >
          <View
            style={{
              width: 28,
              height: 28,
              borderRadius: 8,
              backgroundColor: colors.primary,
              alignItems: 'center',
              justifyContent: 'center',
            }}
          >
            <Icon name="store" size={16} color={colors.onPrimary} />
          </View>
          {!compact && (
            <View style={{ flexShrink: 1, minWidth: 0 }}>
              <Text variant="label" numberOfLines={1} testID="tenant-name">
                {session.tenant.name}{' '}
              </Text>
              <Text
                variant="caption"
                numberOfLines={1}
                style={{ color: colors.foreground, opacity: 0.75 }}
              >
                {session.role.charAt(0) + session.role.slice(1).toLowerCase()}
              </Text>
            </View>
          )}
          <Icon name="chevron-down" size={14} color={colors.muted} />
        </Pressable>
      )}
    >
      {(close) => (
        <View>
          <Text
            variant="fine"
            tone="muted"
            style={{ paddingHorizontal: 12, paddingVertical: 6, textTransform: 'uppercase' }}
          >
            Your businesses
          </Text>
          {(query.data ?? []).map((w) => {
            const current = w.id === session.tenant.id;
            return (
              <Pressable
                key={w.id}
                role="menuitem"
                onPress={async () => {
                  close();
                  if (current) return;
                  try {
                    await switchTo(w.id);
                    navigation.replace(home);
                  } catch (error) {
                    toast.error(messageFor(error));
                  }
                }}
                style={(state) => [
                  {
                    flexDirection: 'row',
                    alignItems: 'center',
                    gap: 10,
                    minHeight: 44,
                    paddingHorizontal: 12,
                    borderRadius: 8,
                  },
                  (state as { hovered?: boolean }).hovered
                    ? { backgroundColor: colors.subtle }
                    : null,
                ]}
              >
                <Avatar name={w.name} size={28} />
                <View style={{ flex: 1, minWidth: 0 }}>
                  <Text variant="label" numberOfLines={1}>
                    {w.name}
                  </Text>
                  <Text variant="caption" tone="muted">
                    {w.role.charAt(0) + w.role.slice(1).toLowerCase()}
                  </Text>
                </View>
                {current && <Icon name="check" size={16} color={colors.primary} />}
              </Pressable>
            );
          })}
          <View
            role="separator"
            style={{ height: 1, backgroundColor: colors.border, marginVertical: 4 }}
          />
          <MenuRow
            item={{ key: 'new', label: 'New business', icon: 'plus', href: '/workspaces/new' }}
            onDone={close}
          />
          {many && (
            <MenuRow
              item={{ key: 'all', label: 'All businesses', icon: 'list', href: '/workspaces' }}
              onDone={close}
            />
          )}
        </View>
      )}
    </Popover>
  );
}

void Row;
